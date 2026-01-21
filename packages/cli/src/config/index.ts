/**
 * Config Barrel Export
 *
 * Exports configuration providers and utilities.
 */

export { type ConfigProvider, LocalConfigProvider } from "./provider"
export type {
	ConfigOrigin,
	ConfigSource,
	ResolvedConfig,
	ResolvedConfigWithOrigin,
} from "./resolver"
export { ConfigResolver } from "./resolver"
