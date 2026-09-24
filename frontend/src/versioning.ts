export interface VersionMetadata {
  name: 'iKuck';
  version: string;
  buildId: string;
}

export const createVersionMetadata = (version: string, rawBuildId: string | undefined): VersionMetadata => ({
  name: 'iKuck',
  version,
  buildId: rawBuildId?.trim() || 'local',
});
