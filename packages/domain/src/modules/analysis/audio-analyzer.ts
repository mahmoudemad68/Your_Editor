/** Port parameterized by the schema-owned section type: domain imports no validator/SDK. */
export interface AudioAnalysisInput {
  readonly filePath: string;
  readonly sourceSha256: string;
  readonly inputSha256: string;
  readonly inputArtifactId: string;
  readonly durationUs: bigint;
  readonly scopeStartUs?: bigint;
  readonly sourceDurationUs?: bigint;
  readonly signal?: AbortSignal;
}
export interface AudioAnalysisConfiguration {
  readonly silenceNoiseDb: number;
  readonly minimumSilenceUs: bigint;
  readonly bucketUs: bigint;
  readonly sampleRate: number;
  readonly timeoutMs: number;
}
export interface IAudioAnalyzer<TSection> {
  analyze(input: AudioAnalysisInput): Promise<TSection>;
}
