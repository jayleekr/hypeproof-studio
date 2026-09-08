import type {TokenPayload} from './tokens';
import type {ActiveSession} from './kv';
import {sha256Hex} from './modules';
/** A native grant survives credential rotation; a different participant never shares it. */
export function nativeObservationScope(payload:TokenPayload,session:ActiveSession){
 return sha256Hex(JSON.stringify([payload.c,payload.u,payload.native_trial?session.session_id:payload.jti,session.session_id]));
}
