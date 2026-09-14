import {Request, ResponseToolkit} from '@hapi/hapi';

import {getRequestLanguage} from './i18n';

export type OutputFormat = 'html' | 'wml';

export interface PaginationOptions<T> {
  budget?: number;
  separatorLength?: number;
  estimateItem?: (item: T) => number;
}

export interface PaginationResult<T> {
  items: T[];
  page: number;
  totalPages: number;
  totalItems: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  previousPage: number | null;
  nextPage: number | null;
  estimatedItemCharacters: number;
  characterBudget: number;
}

interface PaginationPage<T> {
  items: T[];
  estimatedCharacters: number;
}

/** Approximate maximum size of one rendered WML page. */
export const WML_CHARACTER_BUDGET = 3000;

/**
 * Character budget available to repeated items after reserving room for the
 * WML/XML declarations, card structure, headings, navigation, and forms.
 */
export const WML_ITEM_BUDGET = 2300;

/**
 * Determine which output format the reverse proxy requested.
 *
 * A WML-facing virtual host should inject:
 *
 *     X-SuperBasic-Format: wml
 */
export function getRequestFormat(request: Request): OutputFormat {
  const requestedFormat =
    typeof request.headers['x-superbasic-format'] === 'string'
      ? request.headers['x-superbasic-format'].trim().toLowerCase()
      : '';

  return requestedFormat === 'wml' ? 'wml' : 'html';
}

export function isWmlRequest(request: Request): boolean {
  return getRequestFormat(request) === 'wml';
}

/** Safely read a one-based page number from a route query. */
export function getPageNumber(request: Request): number {
  const rawPage = request.query.page === undefined ? 1 : request.query.page;
  const parsedPage = Number.parseInt(String(rawPage), 10);

  if (!Number.isFinite(parsedPage) || parsedPage < 1) {
    return 1;
  }

  return parsedPage;
}

/** Escape text for WML/XML character data or attribute values. */
export function escapeWml(value: unknown): string {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* eslint-disable no-control-regex, no-misleading-character-class */
/**
 * Remove characters and emoji sequences that cannot be represented safely in
 * XML 1.0 or by older WML clients.
 */
export function sanitizeWmlText(value: unknown): string {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(
      /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:[\uFE0E\uFE0F])?(?:[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F])?(?:[\u{1F3FB}-\u{1F3FF}])?)*)/gu,
      '[emoji]'
    )
    .replace(/[\u200D\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/[\uD800-\uDFFF]/g, '');
}
/* eslint-enable no-control-regex, no-misleading-character-class */

export function estimateWmlLength(value: unknown): number {
  return escapeWml(value).length;
}

/** Paginate items according to their estimated rendered WML size. */
export function paginateItems<T>(
  items: T[],
  requestedPage: unknown,
  options: PaginationOptions<T> = {}
): PaginationResult<T> {
  const sourceItems = Array.isArray(items) ? items : [];
  const budget =
    Number.isFinite(options.budget) && Number(options.budget) > 0
      ? Math.floor(Number(options.budget))
      : WML_ITEM_BUDGET;
  const separatorLength =
    Number.isFinite(options.separatorLength) &&
    Number(options.separatorLength) >= 0
      ? Math.floor(Number(options.separatorLength))
      : 24;
  const estimateItem =
    typeof options.estimateItem === 'function'
      ? options.estimateItem
      : (item: T): number => estimateWmlLength(JSON.stringify(item));

  const pages: PaginationPage<T>[] = [];
  let currentPage: T[] = [];
  let currentLength = 0;

  for (const item of sourceItems) {
    let itemLength: number;

    try {
      itemLength = Number(estimateItem(item));
    } catch (err) {
      console.error('[PRESENTATION] estimateItem failed');
      console.error(err instanceof Error ? err.stack : err);
      itemLength = estimateWmlLength(JSON.stringify(item));
    }

    if (!Number.isFinite(itemLength) || itemLength < 0) {
      itemLength = 0;
    }

    itemLength = Math.ceil(itemLength) + separatorLength;

    if (currentPage.length > 0 && currentLength + itemLength > budget) {
      pages.push({
        items: currentPage,
        estimatedCharacters: currentLength,
      });
      currentPage = [];
      currentLength = 0;
    }

    currentPage.push(item);
    currentLength += itemLength;
  }

  if (currentPage.length > 0) {
    pages.push({
      items: currentPage,
      estimatedCharacters: currentLength,
    });
  }

  if (pages.length === 0) {
    pages.push({items: [], estimatedCharacters: 0});
  }

  const parsedRequestedPage = Number.parseInt(String(requestedPage), 10);
  const safeRequestedPage =
    Number.isFinite(parsedRequestedPage) && parsedRequestedPage >= 1
      ? parsedRequestedPage
      : 1;
  const totalPages = pages.length;
  const page = Math.min(safeRequestedPage, totalPages);
  const selectedPage = pages[page - 1];

  return {
    items: selectedPage.items,
    page,
    totalPages,
    totalItems: sourceItems.length,
    hasPreviousPage: page > 1,
    hasNextPage: page < totalPages,
    previousPage: page > 1 ? page - 1 : null,
    nextPage: page < totalPages ? page + 1 : null,
    estimatedItemCharacters: selectedPage.estimatedCharacters,
    characterBudget: budget,
  };
}

/** Render the HTML or WML view selected by the reverse proxy. */
export function renderPage(
  request: Request,
  h: ResponseToolkit,
  viewName: string,
  model: Record<string, unknown> = {},
  statusCode = 200
) {
  const format = getRequestFormat(request);
  const isWml = format === 'wml';
  const language = getRequestLanguage(request);
  const selectedView = isWml
    ? `wml/${language}/${viewName}.wml`
    : `${language}/${viewName}.html`;
  const response = h.view(selectedView, {
    ...model,
    language,
    outputFormat: format,
    isWml,
  });

  response.code(Number.isInteger(statusCode) ? statusCode : 200);
  response.type(
    isWml ? 'text/vnd.wap.wml; charset=utf-8' : 'text/html; charset=utf-8'
  );
  response.header('Content-Language', language);
  response.header('Vary', 'Accept-Language');

  return response;
}
