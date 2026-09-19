// Canonical definition lives in shared so observability can decorate its health routes
// without reaching into auth (which the boundary matrix forbids).
export { IS_PUBLIC_KEY, Public } from '../shared/public';
