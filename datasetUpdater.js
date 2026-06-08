const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = __dirname;
const SOURCE_URL = 'https://www.hltv.org/stats/players?startDate=all&matchType=Majors';
const RAW_JSON_PATH = path.join(PROJECT_ROOT, 'players_data.json');
const CLEANED_JSON_PATH = path.join(PROJECT_ROOT, 'players_data_cleaned.json');
const TABLE_PATH = path.join(PROJECT_ROOT, 'table.txt');
const SAVED_HTML_PATH = path.join(PROJECT_ROOT, 'Counter-Strike Player statistics database _ HLTV.org.html');
const BROWSER_PROFILE_DIR = path.join(PROJECT_ROOT, '.browser-profile', 'hltv-updater');
const BROWSER_DEBUG_PORT = 9333;
const BROWSER_READY_TIMEOUT_MS = 15000;
const BROWSER_UPDATE_TIMEOUT_MS = 120000;
const BROWSER_POLL_INTERVAL_MS = 2500;

function stripTags(value) {
    return value
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

function decodeHtml(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function findBrowserExecutable() {
    const candidates = [];
    if (process.env.BROWSER) {
        candidates.push(process.env.BROWSER);
    }

    if (process.platform === 'win32') {
        candidates.push(
            path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
        );
    }

    for (const candidate of candidates) {
        if (candidate && await fileExists(candidate)) {
            return candidate;
        }
    }

    throw new Error('未找到可用的 Chrome/Edge 浏览器，请先安装后重试。');
}

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`请求调试接口失败: ${response.status} ${response.statusText}`);
    }
    return response.json();
}

async function waitForDebuggerEndpoint(debugPort) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < BROWSER_READY_TIMEOUT_MS) {
        try {
            return await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
        } catch {
            await sleep(500);
        }
    }

    throw new Error('浏览器调试端口未就绪，请检查本机浏览器是否能正常启动。');
}

async function tryGetDebuggerEndpoint(debugPort) {
    try {
        return await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
    } catch {
        return null;
    }
}

class CdpClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.nextId = 1;
        this.pending = new Map();
        this.ws = null;
        this.openPromise = null;
    }

    async connect() {
        if (this.openPromise) {
            return this.openPromise;
        }

        this.openPromise = new Promise((resolve, reject) => {
            const ws = new WebSocket(this.wsUrl);
            this.ws = ws;

            ws.addEventListener('open', () => resolve());
            ws.addEventListener('error', (event) => reject(event.error || new Error('无法连接浏览器调试会话')));
            ws.addEventListener('message', (event) => {
                const payload = JSON.parse(event.data);
                if (!payload.id) {
                    return;
                }

                const handlers = this.pending.get(payload.id);
                if (!handlers) {
                    return;
                }

                this.pending.delete(payload.id);
                if (payload.error) {
                    handlers.reject(new Error(payload.error.message || '浏览器调试命令执行失败'));
                } else {
                    handlers.resolve(payload.result);
                }
            });
            ws.addEventListener('close', () => {
                for (const [, handlers] of this.pending) {
                    handlers.reject(new Error('浏览器调试连接已关闭'));
                }
                this.pending.clear();
            });
        });

        return this.openPromise;
    }

    async send(method, params = {}) {
        await this.connect();
        const id = this.nextId++;

        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async getOuterHtml() {
        await this.send('Runtime.enable');
        const result = await this.send('Runtime.evaluate', {
            expression: 'document.documentElement.outerHTML',
            returnByValue: true,
        });
        return result.result?.value || '';
    }

    close() {
        try {
            this.ws?.close();
        } catch {
            // ignore close errors
        }
    }
}

async function launchBrowserForUpdate() {
    const executablePath = await findBrowserExecutable();
    await fs.mkdir(BROWSER_PROFILE_DIR, { recursive: true });

    const existingEndpoint = await tryGetDebuggerEndpoint(BROWSER_DEBUG_PORT);
    if (existingEndpoint) {
        return {
            debugPort: BROWSER_DEBUG_PORT,
            processHandle: null,
            executablePath,
            reused: true,
        };
    }

    const processHandle = spawn(executablePath, [
        `--remote-debugging-port=${BROWSER_DEBUG_PORT}`,
        `--user-data-dir=${BROWSER_PROFILE_DIR}`,
        '--new-window',
        SOURCE_URL,
    ], {
        stdio: 'ignore',
        windowsHide: false,
    });

    processHandle.unref();
    await waitForDebuggerEndpoint(BROWSER_DEBUG_PORT);

    return {
        debugPort: BROWSER_DEBUG_PORT,
        processHandle,
        executablePath,
        reused: false,
    };
}

function pickStatsTarget(targets) {
    return targets.find((target) =>
        target.type === 'page' &&
        (target.url.includes('hltv.org/stats/players') ||
         target.title.includes('Counter-Strike Player statistics database'))
    ) || targets.find((target) => target.type === 'page');
}

async function getPageHtmlFromBrowser(debugPort) {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
    const target = pickStatsTarget(targets);

    if (!target?.webSocketDebuggerUrl) {
        throw new Error('未找到 HLTV 页面，请不要关闭自动打开的浏览器窗口。');
    }

    const client = new CdpClient(target.webSocketDebuggerUrl);
    try {
        return {
            html: await client.getOuterHtml(),
            url: target.url,
            title: target.title,
        };
    } finally {
        client.close();
    }
}

async function waitForVerifiedStatsPage(debugPort) {
    const startedAt = Date.now();
    let lastMessage = '浏览器页面尚未准备好';

    while (Date.now() - startedAt < BROWSER_UPDATE_TIMEOUT_MS) {
        try {
            const { html, url, title } = await getPageHtmlFromBrowser(debugPort);

            if (html.includes('stats-table player-ratings-table')) {
                return html;
            }

            if (/正在进行安全验证|security verification|恶意自动程序/i.test(html)) {
                lastMessage = '浏览器仍停留在 HLTV 安全验证页，等待验证完成';
            } else {
                lastMessage = `浏览器已打开页面，但尚未出现统计表格: ${title || url}`;
            }
        } catch (error) {
            lastMessage = error.message;
        }

        await sleep(BROWSER_POLL_INTERVAL_MS);
    }

    throw new Error(`${lastMessage}。如果浏览器里还没通过验证，请先完成验证后再重试。`);
}

function normalizePlayerLink(rawHref) {
    if (!rawHref) {
        return 'Unknown';
    }

    let href = decodeHtml(rawHref.trim());
    if (href.startsWith('/')) {
        href = `https://www.hltv.org${href}`;
    }

    href = href.split('?')[0];
    return href.replace('/stats/players/', '/player/');
}

function extractTable(html) {
    const match = html.match(/<table class="stats-table player-ratings-table">([\s\S]*?)<\/table>/);
    if (!match) {
        throw new Error('未找到 HLTV 选手统计表格，可能被安全验证页拦截。');
    }
    return `<table class="stats-table player-ratings-table">${match[1]}</table>`;
}

function parseHeaders(tableHtml) {
    const theadMatch = tableHtml.match(/<thead>([\s\S]*?)<\/thead>/);
    if (!theadMatch) {
        throw new Error('未找到表头信息');
    }

    return Array.from(theadMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)).map((match) => stripTags(match[1]));
}

function parseRows(tableHtml) {
    const tbodyMatch = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/);
    if (!tbodyMatch) {
        throw new Error('未找到表格内容');
    }

    return Array.from(tbodyMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)).map((match) => match[1]);
}

function parsePlayerCell(cellHtml) {
    const linkMatch = cellHtml.match(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const flagMatch = cellHtml.match(/<img[^>]*alt="([^"]+)"/);

    return {
        name: linkMatch ? stripTags(linkMatch[2]) : 'Unknown',
        link: linkMatch ? normalizePlayerLink(linkMatch[1]) : 'Unknown',
        country: flagMatch ? decodeHtml(flagMatch[1]).trim() : 'Unknown',
    };
}

function parseTeamCell(attrs, cellHtml) {
    const sortMatch = attrs.match(/data-sort="([^"]+)"/);
    if (sortMatch) {
        return decodeHtml(sortMatch[1]).trim();
    }

    const imgMatch = cellHtml.match(/<img[^>]*alt="([^"]+)"/);
    if (imgMatch) {
        return decodeHtml(imgMatch[1]).trim();
    }

    const text = stripTags(cellHtml);
    return text || 'No team';
}

function parseSavedHtml(html) {
    if (/正在进行安全验证|security verification|恶意自动程序/i.test(html)) {
        throw new Error('HLTV 返回了安全验证页，暂时无法自动抓取。');
    }

    const tableHtml = extractTable(html);
    const headers = parseHeaders(tableHtml);
    const rows = parseRows(tableHtml);
    const players = {};

    for (const rowHtml of rows) {
        const cells = Array.from(rowHtml.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)).map((match) => ({
            attrs: match[1],
            html: match[2],
        }));

        if (cells.length !== headers.length) {
            continue;
        }

        const rowData = {};
        let playerName = 'Unknown';

        for (let index = 0; index < cells.length; index += 1) {
            const header = headers[index];
            const cell = cells[index];

            if (header === 'Player') {
                const player = parsePlayerCell(cell.html);
                playerName = player.name;
                rowData.Player = player.name;
                rowData.link = player.link;
                rowData.country = player.country;
            } else if (header === 'Teams') {
                rowData.Teams = stripTags(cell.html);
                rowData.team = parseTeamCell(cell.attrs, cell.html);
            } else {
                rowData[header] = stripTags(cell.html);
            }
        }

        if (playerName !== 'Unknown') {
            players[playerName] = rowData;
        }
    }

    return { tableHtml, players };
}

async function readJson(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {};
        }
        throw error;
    }
}

async function readSavedHtml() {
    const fallbackPaths = [SAVED_HTML_PATH, TABLE_PATH];

    for (const filePath of fallbackPaths) {
        try {
            return await fs.readFile(filePath, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    throw new Error('未找到可用的本地 HLTV 缓存文件');
}

function buildOutputs(parsedPlayers, existingCleaned) {
    const rawOutput = {};
    const cleanedOutput = {};

    for (const [playerName, parsed] of Object.entries(parsedPlayers)) {
        const old = existingCleaned[playerName] || {};
        const country = parsed.country || old.country || 'Unknown';
        const team = parsed.team || old.team || 'No team';

        rawOutput[playerName] = {
            ...parsed,
            country,
            team,
            birth_year: old.birth_year ?? 'Unknown',
            role: old.role ?? 'Unknown',
            majapp: old.majapp ?? 0,
        };

        cleanedOutput[playerName] = {
            link: parsed.link || old.link || 'Unknown',
            country,
            team,
            birth_year: old.birth_year ?? 'Unknown',
            role: old.role ?? 'Unknown',
            majapp: old.majapp ?? 0,
        };
    }

    return { rawOutput, cleanedOutput };
}

async function fetchLatestStatsPage() {
    const response = await fetch(SOURCE_URL, {
        headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'cache-control': 'no-cache',
        },
    });

    if (!response.ok) {
        throw new Error(`HLTV 请求失败: ${response.status} ${response.statusText}`);
    }

    return response.text();
}

async function updateDataset(options = {}) {
    const {
        useSavedHtml = false,
        strategy = useSavedHtml ? 'saved_html' : 'browser_assisted',
    } = options;
    let html;
    let source = strategy;
    let browserSession = null;

    if (strategy === 'saved_html') {
        html = await readSavedHtml();
    } else if (strategy === 'live_fetch') {
        html = await fetchLatestStatsPage();
        source = 'live_hltv';
    } else {
        browserSession = await launchBrowserForUpdate();
        html = await waitForVerifiedStatsPage(browserSession.debugPort);
        source = 'browser_assisted';
    }

    const { tableHtml, players } = parseSavedHtml(html);
    const existingCleaned = await readJson(CLEANED_JSON_PATH);
    const { rawOutput, cleanedOutput } = buildOutputs(players, existingCleaned);

    await Promise.all([
        fs.writeFile(RAW_JSON_PATH, `${JSON.stringify(rawOutput, null, 4)}\n`, 'utf8'),
        fs.writeFile(CLEANED_JSON_PATH, `${JSON.stringify(cleanedOutput, null, 4)}\n`, 'utf8'),
        fs.writeFile(TABLE_PATH, `${tableHtml}\n`, 'utf8'),
    ]);

    const previousNames = new Set(Object.keys(existingCleaned));
    const currentNames = new Set(Object.keys(cleanedOutput));
    const added = [...currentNames].filter((name) => !previousNames.has(name));
    const removed = [...previousNames].filter((name) => !currentNames.has(name));

    return {
        success: true,
        source,
        sourceUrl: SOURCE_URL,
        browserSessionReused: Boolean(browserSession?.reused),
        browserProfileDir: source === 'browser_assisted' ? BROWSER_PROFILE_DIR : undefined,
        totalPlayers: currentNames.size,
        addedCount: added.length,
        removedCount: removed.length,
        addedPreview: added.slice(0, 10),
        removedPreview: removed.slice(0, 10),
        updatedAt: new Date().toISOString(),
    };
}

module.exports = {
    SOURCE_URL,
    updateDataset,
};
