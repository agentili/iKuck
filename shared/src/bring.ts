export const BRING_NAME_MAX_LENGTH = 100;
export const BRING_SPEC_MAX_LENGTH = 240;
export const BRING_LIST_ID_MAX_LENGTH = 128;
export const BRING_TIMEOUT_MS = 12000;
export const BRING_MAX_ITEMS = 5000;

export interface BringList {
  id: string;
  name: string;
}

export interface BringStatus {
  enabled: boolean;
  connected: boolean;
  connectionId: string | null;
}

export interface BringConnected extends BringStatus {
  lists: BringList[];
}

export interface BringItem {
  name: string;
  label: string;
  specification: string;
  state: 'purchase' | 'recently';
  mutable: boolean;
}

export interface BringSnapshot {
  connectionId: string;
  listId: string;
  labelsAvailable: boolean;
  items: BringItem[];
}

export type BringAction = 'add' | 'update' | 'complete' | 'restore' | 'remove';

export interface BringMutation {
  connectionId: string;
  listId: string;
  action: BringAction;
  name: string;
  specification: string;
  expectedSpecification?: string;
}

export interface BringCredentials {
  email: string;
  password: string;
  confirmExternalAccess: true;
}

export interface BringImportResult {
  imported: number;
  skipped: number;
  recently: number;
}
