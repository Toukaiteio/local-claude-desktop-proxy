const express = require('express');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const bodyParser = require('body-parser');

const app = express();
const PORT = 44455;

// 使用较大数据限制解析 JSON，以支持 AI 对话的大段上下文
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// 模型名重写函数
function rewriteModelName(model, headers) {
    if (typeof model !== 'string') return model;
    
    // 情况 1: Header 优先。如果有 x-remove-ai-provider: true，直接移除前缀和 * 后的部分，跳过所有 rewrite 规则
    if (headers && headers['x-remove-ai-provider'] === 'true') {
        const prefixMatch = model.match(/^anthropic\/(.+)$/);
        if (prefixMatch) {
            const rest = prefixMatch[1];
            const starIdx = rest.lastIndexOf('*');
            if (starIdx !== -1) {
                return rest.substring(0, starIdx); // 移除 * 及其后面的部分
            }
            return rest; // 仅移除 anthropic/ 前缀
        }
        return model;
    }
    
    // 情况 2: 标准 Rewrite 规则 (anthropic/xxx*abc -> abc/xxx)
    // 必须同时满足有 anthropic/ 前缀和 * 符号
    const match = model.match(/^anthropic\/(.*)\*(.*)$/);
    if (match) {
        const modelName = match[1];
        const provider = match[2];
        
        if (provider) {
            return `${provider}/${modelName}`;
        } else {
            // 如果格式是 anthropic/xxx* (星号后为空)，则直接返回 xxx
            return modelName;
        }
    }
    
    // 其他不符合上述条件的情况（例如没有星号且没有 header），保持原样
    return model;
}

// 拦截请求重写 Body 中的模型名
app.use((req, res, next) => {
    if (req.body && req.body.model) {
        const oldModel = req.body.model;
        const newModel = rewriteModelName(oldModel, req.headers);
        if (oldModel !== newModel) {
            console.log(`[Model Rewrite] ${oldModel} -> ${newModel}`);
            req.body.model = newModel;
        }
    }
    next();
});

// 拦截 count_tokens 请求，因为大多数第三方/兼容平台不支持此端点，会导致 Claude 客户端死循环重试
app.use((req, res, next) => {
    if (req.path.endsWith('/count_tokens')) {
        console.log(`[Mock count_tokens] 拦截并模拟计算 token: ${req.path}`);
        // 粗略估算 token 数量（保守估计：1 token ≈ 3 个字符）
        const textLength = req.body ? JSON.stringify(req.body).length : 0;
        const estTokens = Math.max(1, Math.ceil(textLength / 3));
        return res.status(200).json({ 
            type: 'message_tokens_count',
            input_tokens: estTokens 
        });
    }
    next();
});

// 动态路由函数
const customRouter = function (req) {
    const originalPath = req.path;
    if (originalPath.startsWith('/s/')) {
        const host = originalPath.substring(3).split('/')[0];
        return `https://${host}`;
    } else {
        const host = originalPath.substring(1).split('/')[0];
        return `http://${host}`;
    }
};

// 动态路径重写函数
const customPathRewrite = function (path, req) {
    const originalPath = req.path;
    let remaining = '';
    
    if (originalPath.startsWith('/s/')) {
        remaining = originalPath.substring(3);
    } else {
        remaining = originalPath.substring(1);
    }
    
    // 移除 host 部分，保留真正的目标路径
    const parts = remaining.split('/');
    parts.shift(); // 移除 host
    
    // 如果有 query 参数，也拼上
    const queryIdx = req.url.indexOf('?');
    const query = queryIdx !== -1 ? req.url.substring(queryIdx) : '';
    
    return '/' + parts.join('/') + query;
};

// 挂载代理中间件
app.use('/', createProxyMiddleware({
    target: 'http://placeholder.com', // 占位符，会被 router 覆盖
    router: customRouter,
    pathRewrite: customPathRewrite,
    changeOrigin: true, // 关键：自动修改请求头中的 Host 为目标 Host
    ws: true,           // 支持 WebSocket（以防万一）
    on: {
        proxyReq: (proxyReq, req, res) => {
            // 关键修复：因为使用了 bodyParser，必须调用 fixRequestBody 将解析后的 body 重新写入代理请求
            if (req.body && Object.keys(req.body).length > 0) {
                // 如果原始请求是 chunked，且我们重新计算了长度，必须移除 transfer-encoding 以防 400 Bad Request
                proxyReq.removeHeader('transfer-encoding');
                fixRequestBody(proxyReq, req);
            }
            console.log(`[Proxy Request] ${req.method} ${req.originalUrl} -> ${proxyReq.protocol}//${proxyReq.host}${proxyReq.path}`);
        },
        proxyRes: (proxyRes, req, res) => {
            console.log(`[Proxy Response] ${req.method} ${req.originalUrl} -> Status: ${proxyRes.statusCode}`);
            if (proxyRes.statusCode >= 400) {
                let body = [];
                proxyRes.on('data', function (chunk) {
                    body.push(chunk);
                });
                proxyRes.on('end', function () {
                    body = Buffer.concat(body).toString();
                    console.error(`[Error Body from Target] Status ${proxyRes.statusCode}: ${body}`);
                });
            }
        },
        error: (err, req, res) => {
            console.error(`[Proxy Error] ${err.message}`);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Proxy Error', message: err.message });
            }
        }
    }
}));

app.listen(PORT, () => {
    console.log(`-----------------------------------------`);
    console.log(`Anthropic Proxy Server is running!`);
    console.log(`Listening on: http://localhost:${PORT}`);
    console.log(`-----------------------------------------`);
    console.log(`Routing Rules:`);
    console.log(`  /s/abc/path -> https://abc/path`);
    console.log(`  /abc/path   -> http://abc/path`);
    console.log(`Model Rewrite Rule:`);
    console.log(`  anthropic/xxx*abc -> abc/xxx`);
    console.log(`-----------------------------------------`);
});
