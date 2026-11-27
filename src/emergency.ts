// ARN-137: independent control-plane contract. No live infrastructure wiring or credentials.
// AEGIS/BLACKOUT are latched, monotonic emergency states. A read failure is a stop, never RUN.
export type EmergencyMode = "RUN" | "AEGIS" | "BLACKOUT";
export type EmergencyState = Readonly<{ mode: EmergencyMode; generation: number }>;
export type EmergencyReader = () => Promise<unknown>;

export function parseEmergency(value: unknown): EmergencyState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const mode = v["mode"];
  const generation = v["generation"];
  if (mode !== "RUN" && mode !== "AEGIS" && mode !== "BLACKOUT") return null;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) return null;
  return Object.freeze({ mode, generation });
}

// A permit is only valid for the exact generation that was read at admission.
// It is never a durable dispatch token or proof of infrastructure isolation.
export type EmergencyPermit = Readonly<{ generation: number }>;
export type EmergencyDecision = { allowed: true; permit: EmergencyPermit } | { allowed: false; reason: string };

export class EmergencyGate {
  private highWater = 0;
  private observedMode: EmergencyMode | null = null;
  private readonly read: EmergencyReader;
  constructor(read: EmergencyReader = async () => null) { this.read = read; }

  private async current(): Promise<EmergencyState | null> {
    try {
      const state = parseEmergency(await this.read());
      if (!state || state.generation < this.highWater) return null;
      if (state.generation === this.highWater && this.observedMode !== state.mode) return null;
      this.highWater = state.generation;
      this.observedMode = state.mode;
      return state;
    } catch {
      return null;
    }
  }

  async admit(): Promise<EmergencyDecision> {
    const state = await this.current();
    if (!state) return { allowed: false, reason: "emergency_state_unknown" };
    if (state.mode !== "RUN") return { allowed: false, reason: state.mode };
    return { allowed: true, permit: Object.freeze({ generation: state.generation }) };
  }

  async recheck(permit: EmergencyPermit): Promise<EmergencyDecision> {
    const state = await this.current();
    if (!state) return { allowed: false, reason: "emergency_state_unknown" };
    if (state.mode !== "RUN") return { allowed: false, reason: state.mode };
    if (!permit || permit.generation !== state.generation)
      return { allowed: false, reason: "emergency_generation_changed" };
    return { allowed: true, permit: Object.freeze({ generation: state.generation }) };
  }
}

// A synthetic wrapper for the manager's worker port. It checks immediately before entry.
// A later external emergency must be enforced by independent credential/network/worker isolation.
// Do not claim that this check cancels a call already in flight.
export async function emergencyDispatch<T>(
  gate: EmergencyGate, permit: EmergencyPermit, run: () => Promise<T>,
): Promise<{ status: "refused"; reason: string } | { status: "unknown"; reason: string } | { status: "returned"; result: T }> {
  const decision = await gate.recheck(permit);
  if (!decision.allowed) return { status: "refused", reason: decision.reason };
  try {
    const result = await run();
    const after = await gate.recheck(permit);
    if (!after.allowed) return { status: "unknown", reason: "emergency_changed_after_dispatch" };
    return { status: "returned", result };
  } catch {
    return { status: "unknown", reason: "worker_outcome_unknown" };
  }
}
