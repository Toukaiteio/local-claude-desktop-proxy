const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = 44455;

// Use JSON body parser for model name modification
app.use(bodyParser.json());

// Helper function to rewrite model names
// anthropic/xxx*abc -> abc/xxx
function rewriteModelName(model) {
    if (typeof model !== 'string') return model;
    const match = model.match(/^anthropic\/(.*)\*(.*)$/);
    if (match) {
        return `${match[2]}/${match[1]}`;
    }
    return model;
}

app.use(async (req, res) => {
    const originalPath = req.path;
    
    // Skip if path is empty or just /
    if (!originalPath || originalPath === '/') {
        return res.status(400).json({ error: 'Invalid path. Expected format: /s/domain/path or /domain/path' });
    }

    let targetUrl = '';
    
    // Parsing rules:
    // 1. /s/abc -> https://abc
    // 2. /abc -> http://abc
    
    if (originalPath.startsWith('/s/')) {
        const remaining = originalPath.substring(3); // Remove '/s/'
        if (!remaining) return res.status(400).json({ error: 'Missing target domain after /s/' });
        targetUrl = `https://${remaining}`;
    } else {
        const remaining = originalPath.substring(1); // Remove '/'
        if (!remaining) return res.status(400).json({ error: 'Missing target domain' });
        targetUrl = `http://${remaining}`;
    }

    // Rewrite model name if present in body
    if (req.body && req.body.model) {
        const oldModel = req.body.model;
        const newModel = rewriteModelName(oldModel);
        if (oldModel !== newModel) {
            console.log(`[Model Rewrite] ${oldModel} -> ${newModel}`);
            req.body.model = newModel;
        }
    }

    // Prepare headers for proxying
    const headers = { ...req.headers };
    try {
        const parsedTarget = new URL(targetUrl);
        headers['host'] = parsedTarget.host;
        // Remove headers that might interfere
        delete headers['content-length']; 
    } catch (e) {
        return res.status(400).json({ error: `Invalid target URL generated: ${targetUrl}` });
    }

    console.log(`[Proxy] ${req.method} ${originalPath} -> ${targetUrl}`);

    try {
        const response = await axios({
            method: req.method,
            url: targetUrl,
            data: req.body,
            headers: headers,
            params: req.query,
            validateStatus: () => true, // Forward all status codes
            responseType: 'stream'    // Support streaming for AI responses
        });

        // Forward status and headers
        res.status(response.status);
        Object.entries(response.headers).forEach(([key, value]) => {
            // Some headers shouldn't be forwarded blindly
            if (['transfer-encoding', 'connection', 'keep-alive'].includes(key.toLowerCase())) return;
            res.setHeader(key, value);
        });

        // Pipe the response data back to the client
        response.data.pipe(res);

    } catch (error) {
        console.error(`[Error] ${error.message}`);
        if (error.response) {
            // Error from target server
            res.status(error.response.status).json({
                error: 'Proxy Error from Target',
                message: error.message,
                details: error.response.data
            });
        } else {
            // Network or other error
            res.status(500).json({
                error: 'Internal Proxy Error',
                message: error.message
            });
        }
    }
});

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
