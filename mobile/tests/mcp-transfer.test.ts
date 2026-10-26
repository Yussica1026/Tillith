import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpExport, MAX_MCP_IMPORT_BYTES, parseMcpImport, validateMcpImport } from '../src/lib/mcp-transfer.ts';
import type { McpServer } from '../src/lib/tools-api.ts';

test('exports only manageable remote metadata and never exports credentials', () => {
  const base: McpServer = {
    name: 'remote', active: true, connected: true, transport: 'streamable_http',
    url: 'https://example.com/mcp', headers_present: true, url_secret: false,
    tools: ['private-tool'], readonly: false,
  };
  const document = buildMcpExport([
    { ...base, headers: { Authorization: 'secret-header' }, warning: 'private warning' } as McpServer,
    { ...base, name: 'hidden', url_secret: true },
    { ...base, name: 'query', url: 'https://example.com/mcp?token=secret-query' },
    { ...base, name: 'userinfo', url: 'https://user:secret-password@example.com/mcp' },
    { ...base, name: 'fragment', url: 'https://example.com/mcp#secret-fragment' },
    { ...base, name: 'local', transport: 'stdio' },
    { ...base, name: 'readonly', readonly: true },
    { ...base, name: '__proto__', transport: 'sse' },
  ]);
  const exported = JSON.parse(JSON.stringify(document)).mcpServers;
  assert.deepEqual(exported.remote, { url: base.url, transport: 'streamable_http', active: false });
  for (const name of ['hidden', 'query', 'userinfo', 'fragment']) assert.equal(exported[name].url, '');
  assert.equal(exported.local, undefined);
  assert.equal(exported.readonly, undefined);
  assert.equal(Object.hasOwn(exported, '__proto__'), true);
  assert.equal(exported.__proto__.transport, 'sse');
  assert.doesNotMatch(JSON.stringify(document), /secret|private|Authorization|headers|connected|tools|warning/);
});

test('imports remote entries disabled, preserves headers and rejects process configuration', () => {
  const items = parseMcpImport(JSON.stringify({ mcpServers: {
    remote: { url: 'https://example.com/mcp', type: 'http', active: true, clear_headers: true,
      headers: { Authorization: 'Bearer private-token' } },
    local: { command: 'private-command', args: [], env: {} },
    argsOnly: { url: 'https://example.com', args: [] },
    envOnly: { url: 'https://example.com', env: {} },
    stdio: { transport: 'stdio' },
  } }));
  assert.deepEqual(items[0].draft, {
    name: 'remote', url: 'https://example.com/mcp', transport: 'streamable_http',
    headers: { Authorization: 'Bearer private-token' }, active: false,
  });
  assert.equal(validateMcpImport(items[0], []), '');
  for (const item of items.slice(1)) {
    assert.equal(item.draft.active, false);
    assert.ok(validateMcpImport(item, []));
    assert.doesNotMatch(validateMcpImport(item, []), /private-command|private-token/);
  }
});

test('allows filling a missing address and resolving duplicate names before saving', () => {
  const [item] = parseMcpImport('{"mcpServers":{"existing":{"type":"sse"}}}');
  assert.equal(item.draft.url, '');
  assert.match(validateMcpImport(item, []), /补充/);
  item.draft.url = 'https://example.com/sse';
  assert.match(validateMcpImport(item, ['existing']), /已存在/);
  item.draft.name = 'renamed';
  assert.equal(validateMcpImport(item, ['existing']), '');
  item.draft.url = 'https://example.com/sse?token=private@token';
  assert.equal(validateMcpImport(item, []), '');
});

test('rejects invalid JSON, root shapes, file size and service count without echoing input', () => {
  assert.throws(() => parseMcpImport('{"secret-token":'), { message: 'JSON 格式无效，请检查文件内容。' });
  for (const document of ['null', '[]', '{}', '{"mcpServers":[]}', '{"mcpServers":null}']) {
    assert.throws(() => parseMcpImport(document), /mcpServers/);
  }
  assert.throws(() => parseMcpImport(' '.repeat(MAX_MCP_IMPORT_BYTES + 1)), /1 MB/);
  assert.throws(() => parseMcpImport(JSON.stringify({ mcpServers: Object.fromEntries(
    Array.from({ length: 51 }, (_, index) => [String(index), {}]),
  ) })), /50/);
});

test('rejects malformed entries, URLs and headers with credential-free errors', () => {
  const invalidConfigurations = [
    null, [], { url: 42 }, { active: 'true' }, { transport: 'sse', type: 'http' },
    { url: 'file:///private-token' }, { url: 'https://private-token@example.com' },
    { url: 'https://example.com:65536/private-token' },
    { url: 'https://example.com/#private-token' }, { url: 'https://example.com/\r\nprivate-token' },
    { headers: [] }, { headers: { Authorization: 42 } },
    { headers: { 'Bad Header': 'private-token' } }, { headers: { Authorization: 'private-token\r\ninjected' } },
  ];
  for (const config of invalidConfigurations) {
    const value = config && !Array.isArray(config) ? { url: 'https://example.com', ...config } : config;
    const [item] = parseMcpImport(JSON.stringify({ mcpServers: { remote: value } }));
    const error = validateMcpImport(item, []);
    assert.ok(error, JSON.stringify(config));
    assert.doesNotMatch(error, /private-token|injected/);
  }
  const [item] = parseMcpImport('{"mcpServers":{"remote":{"url":"https://example.com"}}}');
  item.draft.name = '名'.repeat(201);
  assert.match(validateMcpImport(item, []), /200/);
  item.draft.name = 'remote';
  item.draft.url = 'https://example.com/' + 'a'.repeat(8192);
  assert.match(validateMcpImport(item, []), /8192/);
});
