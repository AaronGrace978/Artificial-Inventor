const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
export const PREVIEW_CSP = "default-src 'none'; script-src inventor-preview: 'unsafe-inline'; style-src inventor-preview: 'unsafe-inline'; img-src inventor-preview: data:; font-src inventor-preview:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-forms";

// A virtual read-only origin. It serves exact saved artifacts, never arbitrary
// files from disk, and receives no provider keys or application bridge.
export function createPreviewHandler(getProject) {
  return async request => {
    const headers = { 'Content-Security-Policy': PREVIEW_CSP, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff' };
    try {
      const url = new URL(request.url);
      if (request.method && request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers });
      if (url.protocol !== 'inventor-preview:' || !/^p-[a-f0-9-]{36}$/.test(url.hostname)) throw new Error('Invalid preview origin');
      let name = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
      if (/[\\\0]/.test(name) || name.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid path');
      const project = await getProject(url.hostname.slice(2));
      if (!project || project.kind !== 'web-app') throw new Error('Not a browser project');
      const file = project.files.find(item => item.path === name);
      if (!file) return new Response('File not found', { status: 404, headers });
      const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
      return new Response(file.content, { headers: { ...headers, 'Content-Type': types[extension] || 'text/plain; charset=utf-8' } });
    } catch {
      return new Response('Preview not found', { status: 404, headers });
    }
  };
}
