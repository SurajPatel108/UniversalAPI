export interface Dataset {
  readonly id: string;
  readonly sourceId: string;
  readonly discoveryResultId: string;
  readonly candidateIds: readonly string[];
  readonly name: string;
  readonly selectedScope: readonly string[];
  readonly approvedBy: string;
  readonly approvedAt: Date;
  readonly createdAt: Date;
}
