const { TextDecoder } = require('util');

function prepareSseResponse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

function writeSseEvent(res, event, data) {
  if (event) {
    res.write(`event: ${event}\n`);
  }

  const payload = typeof data === 'string' ? data : JSON.stringify(data ?? {});
  const lines = payload.split(/\r?\n/);
  for (const line of lines) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

async function* parseSseStream(stream) {
  if (!stream || typeof stream.getReader !== 'function') {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  const emitEvent = () => {
    if (!eventName && dataLines.length === 0) {
      return null;
    }
    const event = {
      event: eventName || 'message',
      data: dataLines.join('\n'),
    };
    eventName = '';
    dataLines = [];
    return event;
  };

  const consumeLine = (line) => {
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }

    if (line === '') {
      const event = emitEvent();
      return event;
    }

    if (line.startsWith(':')) {
      return null;
    }

    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }

    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let lineBreakIndex = buffer.indexOf('\n');

      while (lineBreakIndex !== -1) {
        const line = buffer.slice(0, lineBreakIndex);
        buffer = buffer.slice(lineBreakIndex + 1);
        const event = consumeLine(line);
        if (event) {
          yield event;
        }
        lineBreakIndex = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const event = consumeLine(buffer);
      if (event) {
        yield event;
      }
    }

    const trailingEvent = emitEvent();
    if (trailingEvent) {
      yield trailingEvent;
    }
  } finally {
    reader.releaseLock();
  }
}

module.exports = {
  parseSseStream,
  prepareSseResponse,
  writeSseEvent,
};
