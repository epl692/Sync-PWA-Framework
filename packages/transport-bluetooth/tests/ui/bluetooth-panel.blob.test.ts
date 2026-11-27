// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { BluetoothPanel, defineBluetoothPanel, type PanelTransport } from '../../src/ui/bluetooth-panel';

beforeAll(() => defineBluetoothPanel());

const transport: PanelTransport = {
  status: () => ({ kind: 'ready' }),
  connections: () => [],
  chooseHub: async () => undefined,
  disconnectHub: async () => undefined,
  onStatus: () => () => undefined,
  onConnections: () => () => undefined,
};

describe('<sync-bluetooth-panel> files', () => {
  it('shows progress for a file that is coming and a plain message for one too big for Bluetooth', () => {
    const el = document.createElement('sync-bluetooth-panel') as BluetoothPanel;
    document.body.appendChild(el);
    el.transport = transport;
    el.setBlobs([
      { name: 'photo.jpg', size: 4_000_000, bytesDone: 1_000_000 },
      { name: '<b>map.pdf</b>', size: 20 * 1024 * 1024 },
    ]);
    const progress = el.querySelector('progress') as HTMLProgressElement;
    expect(progress.value).toBe(25);
    expect(progress.getAttribute('aria-label')).toBe('Downloading photo.jpg');
    expect(el.querySelector('.bt-blob-wait')!.textContent).toMatch(/too big to send over Bluetooth/);
    expect(el.querySelector('b')).toBeNull(); // file names are untrusted
    el.setBlobs([]);
    expect(el.querySelector('.bt-blobs')).toBeNull();
  });
});
