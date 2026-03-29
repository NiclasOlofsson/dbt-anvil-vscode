export interface CteProfile {
	name: string;
	/** 0-based line in the source SQL file where this CTE is defined */
	definitionLine: number;
	/** Execution time (ms) of the profiling query for this CTE — each query includes all CTEs up to this one, so this naturally grows with each step */
	queryTimeMs: number;
	/** Wall-clock ms attributable to just this CTE (marginal cost) */
	marginalTimeMs: number;
	/** Row count from COUNT(*) on this CTE */
	rowCount: number;
	/** Fraction of the full model's total time (0–1) */
	fractionOfTotal: number;
}

export type ProfileStatus = 'running' | 'complete' | 'partial' | 'error';

export interface ProfileResult {
	modelId: string;
	modelName: string;
	sourceFilePath: string;
	/** Wall-clock ms for the full compiled model query */
	totalTimeMs: number;
	/** Total row count from the full model COUNT(*) */
	totalRowCount: number;
	cteProfiles: CteProfile[];
	/** Unix timestamp (ms) when profiling started */
	timestamp: number;
	status: ProfileStatus;
	error?: string;
	/** Total number of CTEs to profile — set when profiling starts, used for progress display. */
	totalCtes?: number;
	/** CTE names not yet executed — populated at run start, shrinks as each CTE completes. */
	pendingCteNames?: string[];
}
