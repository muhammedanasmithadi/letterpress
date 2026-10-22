import { describe, expect, test } from 'bun:test';
import { Tab } from '../src/browser.ts';

type FakeSocket = {
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
  sent: string[];
  send: (s: string) => void;
  close: () => void;
};

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    onmessage: null,
    onclose: null,
    sent: [],
    send(s: string) {
      socket.sent.push(s);
    },
    close() {},
  };
  return socket;
}

describe('a message from the browser', () => {
  test('a message that is not an object is ignored', () => {
    const socket = fakeSocket();
    new Tab('t1', socket as unknown as WebSocket);
    for (const raw of ['null', '123', '"a string"', 'true', '[]', 'not json']) {
      expect(() => socket.onmessage?.({ data: raw })).not.toThrow();
    }
  });

  test('a command is still answered after a message that is not an object', async () => {
    const socket = fakeSocket();
    const tab = new Tab('t2', socket as unknown as WebSocket);
    const pending = tab.send('Page.enable');
    expect(socket.sent.length).toBe(1);
    socket.onmessage?.({ data: 'null' });
    const id = JSON.parse(socket.sent[0]!).id;
    socket.onmessage?.({ data: JSON.stringify({ id, result: { ok: true } }) });
    expect(await pending).toEqual({ ok: true });
  });
});
