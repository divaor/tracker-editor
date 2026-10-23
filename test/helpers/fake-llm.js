// A stand-in for a local model server with an OpenAI-compatible API (like
// Ollama or LM Studio). Chat answers echo what they were asked, streamed in
// awkward pieces; embeddings are bags of hashed words, so texts that share
// words are similar. /completions (fill in the middle) answers with `complete(body)`,
// or 404 when `complete` is null, as servers without it do.
import { createServer } from 'node:http';

const DIM = 64;

export function embedText(text) {
  const vector = new Array(DIM).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    vector[h % DIM] += 1;
  }
  return vector;
}

export function startFakeLlm({ models = ['llama3.2', 'nomic-embed-text'], answer, complete = () => '' } = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    calls.push({ method: req.method, url: req.url, body });
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/v1/models') return json(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
    if (req.url === '/v1/embeddings') {
      if (!models.includes(body.model)) return json(404, { error: { message: `model "${body.model}" not found, try pulling it first` } });
      const input = Array.isArray(body.input) ? body.input : [body.input];
      return json(200, { object: 'list', data: input.map((text, index) => ({ object: 'embedding', index, embedding: embedText(text) })) });
    }
    if (req.url === '/v1/completions' && complete) {
      if (!models.includes(body.model)) return json(404, { error: { message: `model "${body.model}" not found, try pulling it first` } });
      return json(200, { choices: [{ text: complete(body) }] });
    }
    if (req.url === '/v1/chat/completions') {
      if (!models.includes(body.model)) return json(404, { error: { message: `model "${body.model}" not found, try pulling it first` } });
      const last = body.messages.at(-1).content;
      const text = answer ? answer(body) : `Answer about: ${last.slice(0, 60)}`;
      if (!body.stream) return json(200, { choices: [{ message: { role: 'assistant', content: text } }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [...text.matchAll(/.{1,7}/gsu)].map((m) => `data: ${JSON.stringify({ choices: [{ delta: { content: m[0] } }] })}\n\n`);
      const stream = `${events.join('')}data: [DONE]\n\n`;
      // Write in odd-sized pieces so the client has to handle split lines.
      for (let i = 0; i < stream.length; i += 13) {
        res.write(stream.slice(i, i + 13));
        await new Promise((r) => setTimeout(r, 1));
      }
      return res.end();
    }
    json(404, { error: { message: 'not found' } });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
