export interface VersionMetadata {
  name: 'A tavola';
  version: string;
  buildId: string;
}

export const createVersionMetadata = (version: string, rawBuildId: string | undefined): VersionMetadata => ({
  name: 'A tavola',
  version,
  buildId: rawBuildId?.trim() || 'local',
});
