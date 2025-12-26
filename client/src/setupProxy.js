const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function (app) {
    app.use(
        '/socket.io',
        createProxyMiddleware({
            target: 'http://localhost:3001',
            changeOrigin: true,
            secure: false, // Accept self-signed certs
            ws: false      // Disable WS proxying to avoid conflict with HMR (Socket.io will use polling)
        })
    );
};
