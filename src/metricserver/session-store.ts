import * as crypto from 'crypto';
import { HandleIdentifier, SessionHandle, SessionState } from './types';

function generateHandle(): HandleIdentifier {
	return {
		guid: crypto.randomBytes(16),
		secret: crypto.randomBytes(16),
	};
}

function handleKey(handle: HandleIdentifier): string {
	return handle.guid.toString('hex');
}

export class SessionStore {
	private sessions = new Map<string, SessionState>();

	create(configuration: Record<string, string>, bearerToken?: string): SessionState {
		const sessionId = generateHandle();
		const metricViewEnabled =
			configuration['spark.sql.thriftserver.metadata.metricview.enabled'] === 'true'
			|| configuration['spark.databricks.metadata.metricview.enabled'] === 'true'
			|| configuration['spark.databricks.sql.metricView.bi.compatibilityMode.enabled'] === 'true'
			|| configuration['spark.databricks.sql.metricview.bi.compatibilitymode.enabled'] === 'true';

		const state: SessionState = {
			sessionHandle: { sessionId },
			configuration,
			metricViewEnabled,
			bearerToken,
		};
		this.sessions.set(handleKey(sessionId), state);
		return state;
	}

	get(sessionHandle: SessionHandle): SessionState {
		const key = handleKey(sessionHandle.sessionId);
		let state = this.sessions.get(key);
		if (!state) {
			// Power BI reuses Navigator session handles across server restarts — auto-revive with defaults
			state = {
				sessionHandle,
				configuration: {},
				metricViewEnabled: false,
				bearerToken: undefined,
			};
			this.sessions.set(key, state);
		}
		return state;
	}

	remove(sessionHandle: SessionHandle): boolean {
		return this.sessions.delete(handleKey(sessionHandle.sessionId));
	}

	get size(): number {
		return this.sessions.size;
	}
}
