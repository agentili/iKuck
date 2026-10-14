export class BringError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'BringError';
  }
}
