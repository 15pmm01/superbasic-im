module.exports = {
  apps: [
    {
      name: 'superbasic-im',
      cwd: __dirname,
      script: 'dist/index.js',
      env: {
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        PORT: 4000,
        SUPERBASIC_HTML_HOST: process.env.SUPERBASIC_HTML_HOST || '',
        SUPERBASIC_LANGUAGE: process.env.SUPERBASIC_LANGUAGE || '',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
      max_memory_restart: '350M',
      restart_delay: 2000,
    },
  ],
};
