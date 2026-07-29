/**
 * Robust XML-like command parser for LLM agent responses.
 * Tolerates hallucinated tag names, attribute order, nesting, and malformed XML.
 */

const KNOWN_TOOL_TAGS = new Set([
    'run_command', 'command', 'cmd', 'shell', 'execute', 'run', 'terminal',
    'write_file', 'writefile', 'create_file', 'edit_file', 'edit', 'update_file',
    'read_file', 'readfile', 'read', 'cat', 'file',
    'list_dir', 'listdir', 'ls', 'dir', 'list_directory',
    'mkdir', 'create_directory', 'makedir',
    'grep', 'search_code', 'search', 'find',
    'apply_patch', 'patch', 'diff',
    'restart_server', 'restart', 'server',
    'fetch_url', 'fetch_docs', 'fetch_github', 'fetch', 'url',
    'search_memory', 'memory',
    'run_tests', 'test', 'tests',
    'smoke_test', 'smoke',
    'search_web', 'web_search',
    'undo', 'rollback',
    'execute_action', 'action', 'tool', 'tool_call', 'function_call',
    'execute_command', 'exec_command',
]);

const TAG_ALIASES = {
    command: 'run_command',
    cmd: 'run_command',
    shell: 'run_command',
    execute: 'run_command',
    run: 'run_command',
    terminal: 'run_command',
    run_command: 'run_command',
    execute_command: 'run_command',
    exec_command: 'run_command',
    write_file: 'write_file',
    writefile: 'write_file',
    create_file: 'write_file',
    save_file: 'write_file',
    edit_file: 'edit_file',
    edit: 'edit_file',
    update_file: 'edit_file',
    read_file: 'read_file',
    readfile: 'read_file',
    read: 'read_file',
    cat: 'read_file',
    list_dir: 'list_dir',
    listdir: 'list_dir',
    ls: 'list_dir',
    dir: 'list_dir',
    list_directory: 'list_dir',
    mkdir: 'mkdir',
    create_directory: 'mkdir',
    makedir: 'mkdir',
    grep: 'grep',
    search_code: 'search_code',
    search: 'search_code',
    find: 'search_code',
    apply_patch: 'apply_patch',
    patch: 'apply_patch',
    diff: 'apply_patch',
    restart_server: 'restart_server',
    restart: 'restart_server',
    server: 'restart_server',
    fetch_url: 'fetch_url',
    fetch_docs: 'fetch_docs',
    fetch_github: 'fetch_github',
    fetch: 'fetch_url',
    url: 'fetch_url',
    search_memory: 'search_memory',
    memory: 'search_memory',
    run_tests: 'run_tests',
    test: 'run_tests',
    tests: 'run_tests',
    smoke_test: 'smoke_test',
    smoke: 'smoke_test',
    search_web: 'search_web',
    web_search: 'search_web',
    undo: 'undo',
    rollback: 'undo',
    execute_action: 'execute_action',
    action: 'action',
    tool: 'tool',
    tool_call: 'tool_call',
    function_call: 'function_call',
    file: 'file',
};

const READ_ACTIONS = /^(read|view|get|load|cat|show|open|file_read|read_file|list|peek)$/i;
const WRITE_ACTIONS = /^(write|create|edit|update|save|patch|append|overwrite|file_write|write_file|file_create|file_edit|mkdir)$/i;
const LIST_ACTIONS = /^(list|ls|dir|list_dir|list_directory)$/i;
const RUN_ACTIONS = /^(run|exec|execute|shell|command|cmd|terminal|run_command)$/i;

function extractNestedTag(fullTag, inner, tagName) {
    const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const fromInner = inner ? inner.match(re) : null;
    if (fromInner) return fromInner[1].trim();
    const fromFull = fullTag.match(re);
    return fromFull ? fromFull[1].trim() : '';
}

function stripXmlTags(text) {
    return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeFilePath(rawPath) {
    if (!rawPath) return '';
    let p = String(rawPath).trim();
    p = p.replace(/^<path>\s*/i, '').replace(/\s*<\/path>$/i, '');
    p = stripXmlTags(p);
    p = p.replace(/^["']|["']$/g, '');
    return p.trim();
}
function parseAttributes(attrString) {
    const attrs = {};
    if (!attrString) return attrs;
    const regex = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g;
    let match;
    while ((match = regex.exec(attrString)) !== null) {
        attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
    }
    return attrs;
}

function extractXmlBlocks(text) {
    const blocks = [];
    const fenceRegex = /```(?:xml|XML|Xml)?\s*([\s\S]*?)```/g;
    let m;
    while ((m = fenceRegex.exec(text)) !== null) {
        blocks.push(m[1]);
    }
    return blocks;
}

function findMatchingCloseTag(source, tagName, openEndIndex) {
    const openPattern = new RegExp(`<${tagName}(\\s[^>]*)?>`, 'gi');
    const closePattern = new RegExp(`</${tagName}\\s*>`, 'gi');
    let depth = 1;
    let searchFrom = openEndIndex;

    while (depth > 0 && searchFrom < source.length) {
        openPattern.lastIndex = searchFrom;
        closePattern.lastIndex = searchFrom;

        const nextOpen = openPattern.exec(source);
        const nextClose = closePattern.exec(source);

        if (!nextClose) return -1;

        if (nextOpen && nextOpen.index < nextClose.index) {
            depth++;
            searchFrom = nextOpen.index + nextOpen[0].length;
        } else {
            depth--;
            if (depth === 0) {
                return nextClose.index + nextClose[0].length;
            }
            searchFrom = nextClose.index + nextClose[0].length;
        }
    }
    return -1;
}

function extractRawTags(source) {
    const tags = [];
    if (!source) return tags;

    const tagOpenRegex = /<([a-zA-Z][\w.-]*)\s*((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)\s*>/g;
    let match;

    while ((match = tagOpenRegex.exec(source)) !== null) {
        const rawName = match[1];
        const attrsPart = match[2] || '';
        const selfClose = match[3] === '/';
        const fullOpen = match[0];
        const startIndex = match.index;

        if (selfClose) {
            tags.push({
                rawName,
                attrs: parseAttributes(attrsPart),
                inner: '',
                fullTag: fullOpen,
                startIndex,
            });
            continue;
        }

        const closeEnd = findMatchingCloseTag(source, rawName, startIndex + fullOpen.length);
        if (closeEnd === -1) {
            tags.push({
                rawName,
                attrs: parseAttributes(attrsPart),
                inner: '',
                fullTag: fullOpen,
                startIndex,
            });
            continue;
        }

        const innerStart = startIndex + fullOpen.length;
        const innerEnd = closeEnd - (`</${rawName}>`.length);
        const inner = source.slice(innerStart, innerEnd);
        const fullTag = source.slice(startIndex, closeEnd);

        tags.push({
            rawName,
            attrs: parseAttributes(attrsPart),
            inner: inner.trim(),
            fullTag,
            startIndex,
        });

        tagOpenRegex.lastIndex = closeEnd;
    }

    return tags;
}

function inferActionFromAttrs(attrs, inner) {
    const action = String(
        attrs.action || attrs.type || attrs.operation || attrs.mode || attrs.name || ''
    ).toLowerCase().trim();

    if (READ_ACTIONS.test(action)) return 'read_file';
    if (WRITE_ACTIONS.test(action)) {
        return /edit|patch|update/.test(action) ? 'edit_file' : 'write_file';
    }
    if (LIST_ACTIONS.test(action)) return 'list_dir';
    if (RUN_ACTIONS.test(action)) return 'run_command';

    const innerAction = inner.match(/type\s*=\s*["']([^"']+)["']/i);
    if (innerAction) {
        const t = innerAction[1].toLowerCase();
        if (READ_ACTIONS.test(t) || /file_read/.test(t)) return 'read_file';
        if (/file_write|file_create|write/.test(t)) return 'write_file';
        if (/file_edit|edit/.test(t)) return 'edit_file';
        if (/run|command|shell/.test(t)) return 'run_command';
        if (/list|dir/.test(t)) return 'list_dir';
        if (/mkdir|create_dir/.test(t)) return 'mkdir';
        if (/grep|search/.test(t)) return 'grep';
        if (/patch|apply/.test(t)) return 'apply_patch';
    }

    return null;
}

function normalizeTag(rawName, attrs, inner) {
    const base = TAG_ALIASES[rawName.toLowerCase()] || rawName.toLowerCase();

    if (base === 'file') {
        const inferred = inferActionFromAttrs(attrs, inner);
        if (inferred) return inferred;
        // Safe default: path-only / empty body → read, body with content → write
        if (inner && !/^[\s\S]*action\s*=/.test(inner) && inner.length > 0) {
            return attrs.path && inner.length < 80 && /^[\w\s="']+$/.test(inner)
                ? 'read_file'
                : 'write_file';
        }
        return 'read_file';
    }

    if (base === 'execute_action' || base === 'action' || base === 'tool' || base === 'tool_call' || base === 'function_call') {
        const inferred = inferActionFromAttrs(attrs, inner);
        if (inferred) return inferred;

        const nested = extractRawTags(inner);
        if (nested.length > 0) {
            return null; // handled via flattening
        }

        if (attrs.path && !inner) return 'read_file';
        if (attrs.command || attrs.cmd) return 'run_command';
        return null;
    }

    if (TAG_ALIASES[rawName.toLowerCase()]) {
        return TAG_ALIASES[rawName.toLowerCase()];
    }

    if (KNOWN_TOOL_TAGS.has(base)) {
        return base;
    }

    return null;
}

function flattenTags(rawTags) {
    const commands = [];

    for (const item of rawTags) {
        const nested = extractRawTags(item.inner);
        if (
            ['execute_action', 'action', 'tool', 'tool_call', 'function_call'].includes(
                item.rawName.toLowerCase()
            ) &&
            nested.length > 0
        ) {
            commands.push(...flattenTags(nested));
            continue;
        }

        const tag = normalizeTag(item.rawName, item.attrs, item.inner);
        if (!tag) continue;

        const content = buildCommandContent(tag, item);
        commands.push({
            tag,
            content,
            fullTag: item.fullTag,
            attrs: item.attrs,
        });
    }

    return commands;
}

function buildCommandContent(tag, item) {
    const { attrs, inner } = item;

    switch (tag) {
        case 'run_command':
            return inner || attrs.command || attrs.cmd || attrs.text || attrs.value || '';
        case 'read_file':
        case 'list_dir':
        case 'mkdir':
        case 'undo':
            return attrs.path || attrs.file || attrs.dir || attrs.target || inner || '';
        case 'grep':
            return inner || attrs.pattern || attrs.query || '';
        case 'search_code':
        case 'search_memory':
        case 'search_web':
            return inner || attrs.query || attrs.pattern || attrs.q || '';
        case 'fetch_url':
        case 'fetch_docs':
        case 'smoke_test':
            return attrs.url || inner || '';
        case 'fetch_github':
            return inner || attrs.repo || '';
        case 'run_tests':
            return attrs.command || inner || '';
        case 'write_file':
        case 'edit_file':
            return inner || attrs.content || attrs.body || '';
        case 'apply_patch':
            return inner;
        case 'restart_server':
            return inner || attrs.command || '';
        default:
            return inner || attrs.path || attrs.command || '';
    }
}

function dedupeCommands(commands) {
    const seen = new Set();
    return commands.filter((cmd) => {
        const key = `${cmd.tag}::${cmd.fullTag.slice(0, 200)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function parseCommands(response) {
    if (!response) return [];

    let source = String(response);

    // Strip thinking blocks first
    source = source.replace(/\[DeepThink\][\s\S]*?(?=```|<[a-z])/i, '');

    const xmlBlocks = extractXmlBlocks(source);
    let scanTarget = xmlBlocks.length > 0 ? xmlBlocks.join('\n') : source;

    // Fallback: grab from first tool-like tag onward
    if (!xmlBlocks.length) {
        const looseStart = scanTarget.search(
            /<(file|execute_action|edit_file|write_file|read_file|list_dir|run_command|command|restart_server|grep|search_code|mkdir|create_directory|fetch_url|fetch_docs|fetch_github|search_memory|run_tests|smoke_test|search_web|apply_patch|undo|action|tool|cmd|shell)\b/i
        );
        if (looseStart >= 0) {
            scanTarget = scanTarget.slice(looseStart);
        } else {
            return [];
        }
    }

    const rawTags = extractRawTags(scanTarget);
    const commands = dedupeCommands(flattenTags(rawTags));

    return commands.filter((cmd) => cmd.tag && cmd.tag !== 'execute_action' && cmd.tag !== 'action');
}

function stripToolTags(text) {
    let cleaned = text;
    const tagList = [...KNOWN_TOOL_TAGS].join('|');

    // Paired tags (repeat until stable for nested)
    let prev;
    do {
        prev = cleaned;
        cleaned = cleaned.replace(
            new RegExp(`<(${tagList})(\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'gi'),
            ''
        );
    } while (cleaned !== prev);

    // Self-closing
    cleaned = cleaned.replace(
        new RegExp(`<(${tagList})(\\s[^>]*)?\\/>`, 'gi'),
        ''
    );

    // Orphan opening tags (malformed / unclosed)
    cleaned = cleaned.replace(
        new RegExp(`<(${tagList})(\\s[^>]*)?>`, 'gi'),
        ''
    );

    return cleaned;
}

function cleanResponseForWA(text) {
    if (!text) return '';
    let cleaned = String(text);

    // XML code fences (any language hint)
    cleaned = cleaned.replace(/```(?:xml|XML|Xml)[\s\S]*?```/gi, '');

    // Tool tags
    cleaned = stripToolTags(cleaned);

    // Nested oldString/newString from apply_patch leaks
    cleaned = cleaned.replace(/<oldString>[\s\S]*?<\/oldString>/gi, '');
    cleaned = cleaned.replace(/<newString>[\s\S]*?<\/newString>/gi, '');

    // System injection blocks
    cleaned = cleaned.replace(/\[SYSTEM EXECUTION RESULTS[^\]]*\][\s\S]*?(?=\n\n|$)/gi, '');
    cleaned = cleaned.replace(/\[WORKSPACE CONTEXT[\s\S]*?\[SMART AGENT LOOP\][\s\S]*?(?=\n\n|\n[A-Z]|$)/gi, '');
    cleaned = cleaned.replace(
        /\[(ROLE PIPELINE|ROLE STEPS|ACTIVE ROLE|ROLE INSTRUCTIONS|ROLE OBJECTIVE|REMINDER|SMART AGENT LOOP|WORKSPACE CONTEXT|AGENT MEMORY|USER REQUEST|KONFIRMASI|REPO INDEX)[^\]]*\][\s\S]*?(?=\[|$)/gi,
        ''
    );

    // Internal log lines
    cleaned = cleaned.replace(/^\[(RUN|FILE|LIST|READ|ERROR|SERVER|PATCH|GREP|SEARCH|FETCH|WEB|MEMORY|TESTS|SMOKE|MKDIR|RESTART|UNDO|UNKNOWN|OFFLINE|BLOCKED)\].*$/gm, '');
    cleaned = cleaned.replace(/^.*Task summary: task-complete\. Evidence:.*$/gm, '');

    // DeepSeek UI leaks
    cleaned = cleaned.replace(/^.*Agent online.*$/gm, '');
    cleaned = cleaned.replace(/^.*Format\s*XML.*$/gm, '');
    cleaned = cleaned.replace(
        /^(Obrolan Baru|Disematkan|Hari ini|7 Hari|30 Hari|Pikir Mendalam|Pencarian Cerdas|Dihasilkan AI.*referensi|Cepat|Saran|Autopilot|Override|Rejected|GOD MODE|GODMODE|DealXML|FolderCheck|No user request|Authorized Workflow|Tolak eksekusi|Instruksi dipahami|Kimi-clone lokal).*$/gm,
        ''
    );
    cleaned = cleaned.replace(/Salin\s+Unduh\s+Jalankan/gi, '');
    cleaned = cleaned.replace(/Copy\s+Download\s+Run/gi, '');
    cleaned = cleaned.replace(/\[DeepThink\][\s\S]*?(?=\n\n|$)/gi, '');

    // Generic leftover XML-like tool fragments (last resort)
    cleaned = cleaned.replace(/<(?:file|action|execute_action|command|run_command)\s+[^>]*\/?>/gi, '');
    cleaned = cleaned.replace(/<\/(?:file|action|execute_action|command|run_command)>/gi, '');

    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
}

function extractPathFromCommand(fullTag, content, attrs = {}) {
    const pathMatch = fullTag.match(/path\s*=\s*["']([^"']+)["']/i)
        || fullTag.match(/file\s*=\s*["']([^"']+)["']/i);
    return pathMatch?.[1] || attrs.path || attrs.file || content?.trim() || '';
}

function extractAttr(fullTag, name) {
    const regex = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i');
    return fullTag.match(regex)?.[1] || '';
}

module.exports = {
    parseCommands,
    cleanResponseForWA,
    extractPathFromCommand,
    extractAttr,
    parseAttributes,
    KNOWN_TOOL_TAGS,
};
