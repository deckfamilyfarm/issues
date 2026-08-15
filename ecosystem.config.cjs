module.exports = {
  apps: [
    {
      name: "issues",
      script: "server.mjs",
      cwd: ".",
      max_memory_restart: "256M",
      node_args: "--max_old_space_size=256",
      log_date_format: "YYYY-MM-DD HH:mm Z",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "3021",
      },
    },
  ],
};
