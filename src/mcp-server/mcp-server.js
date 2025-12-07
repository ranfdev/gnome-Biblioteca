#!/usr/bin/env -S gjs -m
import { programArgs, programInvocationName } from "system";
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {MCPServer} from './mcp-framework.js';
import {score, hasMatch} from '../sidebar/fzy.js';

// ====================================================
// Utils & Logic
// ====================================================

function getDocIndexPath() {
    if (GLib.getenv("BIBLIOTECA_DOC_INDEX")) {
        return GLib.getenv("BIBLIOTECA_DOC_INDEX");
    }

    const searchPaths = [
        GLib.getenv("BIBLIOTECA_PKGDATADIR"),
        "/app/share/biblioteca",
        "/app/share/app.drey.Biblioteca.Devel",
        "/app/share/app.drey.Biblioteca",
        "/usr/share/biblioteca",
        "/usr/local/share/biblioteca"
    ];

    for (const path of searchPaths) {
        if (!path) continue;
        const fullPath = GLib.build_filenamev([path, "doc-index.json"]);
        if (Gio.File.new_for_path(fullPath).query_exists(null)) {
            return fullPath;
        }
    }
    
    // Fallback to default if not found
    return "/app/share/biblioteca/doc-index.json";
}

const DOC_INDEX_PATH = getDocIndexPath();

let doc_index = null;
let flattened_docs = [];

function loadDocs() {
    const file = Gio.File.new_for_path(DOC_INDEX_PATH);
    if (!file.query_exists(null)) {
        console.warn(`doc-index.json not found. Checked locations including: ${DOC_INDEX_PATH}`);
        return;
    }
    
    try {
        const [success, contents] = file.load_contents(null);
        if (success) {
            const json = new TextDecoder().decode(contents);
            doc_index = JSON.parse(json);
            flattened_docs = [];
            
            const flatten = (items) => {
                for (const item of items) {
                    if (item.search_name) {
                        flattened_docs.push(item);
                    }
                    if (item.children) {
                        flatten(item.children);
                    }
                }
            };
            
            if (doc_index.docs) {
                flatten(doc_index.docs);
            }
            console.log(`Loaded ${flattened_docs.length} docs from index.`);
        }
    } catch (e) {
        console.error("Failed to load doc-index.json", e);
    }
}

function readFile(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) return null;
    
    try {
        const [success, contents] = file.load_contents(null);
        if (!success) return null;
        return new TextDecoder().decode(contents);
    } catch (e) {
        console.error(`Failed to read file ${path}: ${e.message}`);
        return null;
    }
}

// Decode HTML entities comprehensively
function decodeHTMLEntities(text) {
    const entities = {
        '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', 
        '&quot;': '"', '&apos;': "'", '&copy;': '©', '&reg;': '®',
        '&ldquo;': '"', '&rdquo;': '"', '&lsquo;': "'", '&rsquo;': "'",
        '&mdash;': '—', '&ndash;': '–', '&hellip;': '…'
    };
    // Replace named entities
    let result = text.replace(/&[a-zA-Z]+;/g, match => entities[match] || match);
    // Replace numeric entities
    result = result.replace(/&#(\d+);/g, (match, code) => String.fromCharCode(parseInt(code)));
    result = result.replace(/&#x([0-9a-f]+);/gi, (match, code) => String.fromCharCode(parseInt(code, 16)));
    return result;
}

// Standard response formatter
function createTextResponse(text) {
    return {
        content: [{ type: 'text', text }]
    };
}

function htmlToMarkdown(html) {
    // 1. Remove scripts, styles, head, meta
    let text = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
                   .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
                   .replace(/<head\b[^>]*>([\s\S]*?)<\/head>/gim, "")
                   .replace(/<meta\b[^>]*>/gim, "");

    // 2. Extract body if present
    const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/im);
    if (bodyMatch) text = bodyMatch[1];

    // 3. Handle code blocks first to preserve content (don't decode here - will decode after restoration)
    const codeBlocks = [];
    const saveCode = (content, isBlock) => {
        const placeholder = `__CODEBLOCK_${codeBlocks.length}__`;
        codeBlocks.push(isBlock ? "```\n" + content + "\n```" : "`" + content + "`");
        return placeholder;
    };

    // Handle <pre><code>...</code></pre>
    text = text.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gim, (match, content) => saveCode(content, true));
    // Handle <pre>...</pre>
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gim, (match, content) => saveCode(content, true));
    // Handle <code>...</code>
    text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gim, (match, content) => saveCode(content, false));

    // 4. Convert headers
    text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gim, (match, level, content) => {
        return "\n\n" + "#".repeat(parseInt(level)) + " " + content.trim() + "\n\n";
    });

    // 5. Convert links
    text = text.replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gim, (match, url, content) => {
        return `[${content.trim()}](${url})`;
    });

    // 6. Convert lists
    text = text.replace(/<li[^>]*>/gim, "\n- ");
    text = text.replace(/<\/li>/gim, "");
    text = text.replace(/<\/?ul[^>]*>/gim, "");
    text = text.replace(/<\/?ol[^>]*>/gim, "");

    // 7. Convert paragraphs and line breaks
    text = text.replace(/<p[^>]*>/gim, "\n\n");
    text = text.replace(/<\/p>/gim, "");
    text = text.replace(/<br\s*\/?>/gim, "\n");
    text = text.replace(/<hr\s*\/?>/gim, "\n---\n");
    text = text.replace(/<\/?div[^>]*>/gim, "\n");

    // 8. Basic formatting
    text = text.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gim, "**$1**");
    text = text.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gim, "*$1*");

    // 9. Strip remaining tags
    text = text.replace(/<[^>]+>/g, "");

    // 10. Restore code blocks with decoded entities
    text = text.replace(/__CODEBLOCK_(\d+)__/g, (match, index) => {
        return codeBlocks[parseInt(index)];
    });

    // 11. Decode entities (once, comprehensively)
    text = decodeHTMLEntities(text);

    // 12. Normalize whitespace (but not aggressively - preserve intentional formatting)
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/\n\s*\n\s*\n/g, "\n\n");
    
    return text.trim();
}

// Initialize docs
loadDocs();

// ====================================================
// Server Instantiation
// ====================================================

export function runServer(args) {
    // Check command line args for mode
    // Usage: ./biblioteca-server.js --http
    const mode = args.includes('--http') ? 'http' : 'stdio';

    const server = new MCPServer("biblioteca-docs", "1.0.0", { transport: mode, port: 8080 });

    // 1. List Docs
    server.tool(
        "list_docs",
        "Lists available documentation from the global index.",
        { type: "object", properties: {}, required: [] },
        async () => {
            if (!doc_index) throw new Error("Documentation index not loaded.");

            // LOGGING: Check the size before sending (visible in MCP logs)
            const count = doc_index.docs.length;
            server.log(1, `Found ${count} top-level entries.`);

            // OPTIMIZATION: Map to a lighter structure
            // We strip out 'search_name' (full text) and 'children' (if deep/heavy)
            // or just pick the UI-relevant fields.
            const lightDocs = doc_index.docs.map(doc => ({
                name: doc.name,
                tag: doc.tag,
                uri: doc.uri,
                // Include children only if they are just headers, 
                // but if they contain text, you might want to strip them or map them recursively.
                children: doc.children ? doc.children.map(c => ({
                    name: c.name, 
                    uri: c.uri 
                })) : []
            }));

            // Log the approximate size of the payload to confirm we are not sending too much data
            const payloadSize = JSON.stringify(lightDocs).length;
            server.log(1, `Payload size: ~${Math.round(payloadSize/1024)}KB`);

            return createTextResponse(JSON.stringify({ docs: lightDocs }));
        }
    );

    // 2. Search Docs
    server.tool(
        "search_docs",
        "Search documentation using fuzzy search.",
        {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"]
        },
        ({ query }) => {
            if (!flattened_docs.length) {
                return createTextResponse("Documentation index empty or not loaded.");
            }
            
            // Validate query type
            if (typeof query !== 'string') {
                return createTextResponse(JSON.stringify({ 
                    error: "Invalid query: must be a string",
                    results: [] 
                }));
            }
            
            // Normalize query: remove whitespace and handle case sensitivity
            // (matching the behavior in SearchView.js)
            const needle = query.replace(/\s+/g, "");
            if (!needle) {
                return createTextResponse(JSON.stringify({ results: [] }));
            }
            
            const isCaseSensitive = needle.toLowerCase() !== needle;
            const actualNeedle = isCaseSensitive ? needle : needle.toLowerCase();
            
            const filteredResults = flattened_docs
                .filter(item => {
                    // Ensure search_name exists and is a string
                    if (!item.search_name || typeof item.search_name !== 'string') {
                        return false;
                    }
                    const haystack = isCaseSensitive 
                        ? item.search_name 
                        : item.search_name.toLowerCase();
                    return hasMatch(actualNeedle, haystack);
                })
                .map(item => {
                    const haystack = isCaseSensitive 
                        ? item.search_name 
                        : item.search_name.toLowerCase();
                    const s = score(actualNeedle, haystack);
                    return { item, score: s };
                })
                .filter(r => r.score > -Infinity)
                .sort((a, b) => b.score - a.score)
                .slice(0, 20)
                .map(r => ({
                    name: r.item.name,
                    tag: r.item.tag,
                    uri: r.item.uri,
                    score: r.score
                }));
            
            return createTextResponse(JSON.stringify({ results: filteredResults }));
        }
    );

    // 3. Read Resource
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    server.tool(
        "read_resource",
        "Read a documentation resource by URI.",
        {
            type: "object",
            properties: { uri: { type: "string" } },
            required: ["uri"]
        },
        async ({ uri }) => {
            let path = uri;
            if (uri.startsWith("file://")) {
                path = GLib.filename_from_uri(uri)[0];
            }
            
            const rawContent = readFile(path);
            if (!rawContent) {
                return createTextResponse("File not found");
            }
            
            // Validate file size before processing
            const fileSizeBytes = rawContent.length;
            if (fileSizeBytes > MAX_FILE_SIZE) {
                const fileSizeMB = (fileSizeBytes / 1024 / 1024).toFixed(2);
                const maxSizeMB = (MAX_FILE_SIZE / 1024 / 1024).toFixed(2);
                return createTextResponse(
                    `File too large (${fileSizeMB}MB). Maximum file size: ${maxSizeMB}MB`
                );
            }
            
            const content = htmlToMarkdown(rawContent);
            return createTextResponse(content);
        }
    );

    // 4. Server Status
    server.tool(
        "server_status",
        "Get the status of the documentation index and server health.",
        { type: "object", properties: {}, required: [] },
        async () => {
            if (!doc_index) {
                return createTextResponse(JSON.stringify({ 
                    status: "unhealthy",
                    message: "Documentation index failed to load",
                    docs_available: 0
                }));
            }
            return createTextResponse(JSON.stringify({
                status: "healthy",
                message: "Documentation index loaded successfully",
                docs_available: flattened_docs.length
            }));
        }
    );

    server.start();
}

if (programInvocationName.endsWith('mcp-server.js')) {
    runServer(programArgs);
}
