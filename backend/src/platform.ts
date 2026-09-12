export interface PlatformProbe {
  ping: () => Promise<void>;
}

export interface PlatformDependencies {
  database: PlatformProbe;
  cache: PlatformProbe;
}
