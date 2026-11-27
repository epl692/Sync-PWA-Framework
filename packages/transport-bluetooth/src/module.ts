/**
 * The Bluetooth transport as an ordinary module (spec 003): it registers one transport, declares no object types, and reaches
 * data only through the core the host gives the transport. Apps enable it per app (list `bluetooth.link` in `transports`) and
 * per Space (`enabledSpaces`).
 */

import type { ModuleDefinition } from '@sync/modules';
import { createBluetoothTransport, type BluetoothTransportOptions } from './index';

export interface BluetoothModuleConfig {
  /** Spaces the transport may prove membership for. `'all'` (default): every Space this device can prove. */
  enabledSpaces?: string[] | 'all';
  options: BluetoothTransportOptions;
}

export const BLUETOOTH_MODULE_ID = 'bluetooth';
export const BLUETOOTH_TRANSPORT_ID = 'link';

export function bluetoothModule(cfg: BluetoothModuleConfig): ModuleDefinition {
  const spaces = cfg.enabledSpaces === undefined || cfg.enabledSpaces === 'all' ? undefined : [...cfg.enabledSpaces];
  return {
    id: BLUETOOTH_MODULE_ID,
    version: '0.1.0',
    // no object types and no data access: the transport sees only encrypted packets handed to it by the core
    access: { types: { read: [], write: [] }, spaces: { read: 'bound', write: 'bound' } },
    provides: {
      transports: [
        {
          id: BLUETOOTH_TRANSPORT_ID,
          create: () => createBluetoothTransport({ ...cfg.options, ...(spaces ? { spaces } : {}) }),
        },
      ],
    },
  };
}
