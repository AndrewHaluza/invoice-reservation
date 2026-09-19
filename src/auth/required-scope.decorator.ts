// Canonical definition lives in shared so the api layer can declare its required
// scope without importing auth, which the boundary matrix forbids.
export { REQUIRED_SCOPE_KEY, RequiredScope } from '../shared/scope';
