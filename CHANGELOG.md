# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added schema versioning for cache schema to prevent repeated cache invalidations. Fixes cache not being used when models metadata fetched from the endpoints do not contain reasoning metadata.

## [0.3.0] - 2026-07-03

### Added
- Added a free-model verifier CLI and probe pipeline for validating free-tier model availability. ([2de1c6a](https://github.com/MasuRii/pi-model-discovery/commit/2de1c6a8f1ac59162a348d76e52984e5a27d90be))
- Added an `enabled` config toggle and dynamic builtin provider IDs. ([530f26f](https://github.com/MasuRii/pi-model-discovery/commit/530f26f32112951e91b2d496c7ecdc1493d6b971))

### Changed
- Consolidated fetch helpers, record validation, cache, and catalog command helpers. ([abb734d](https://github.com/MasuRii/pi-model-discovery/commit/abb734d235f9679cd7c30803534e9f64635d5576) [f27c497](https://github.com/MasuRii/pi-model-discovery/commit/f27c497bcd73d951ccac21de1a69e3cc49c72415) [ad4ff35](https://github.com/MasuRii/pi-model-discovery/commit/ad4ff35ffaf36ac2803191aae22b65fedaad19ee))
- Updated tests for refactored modules. ([71aa4e5](https://github.com/MasuRii/pi-model-discovery/commit/71aa4e523af3ad0a74eaefa30664738d69991c4c))
- Updated README with badges, standalone-mode documentation, and related extensions. ([4e575ff](https://github.com/MasuRii/pi-model-discovery/commit/4e575ffdc71ecf0cf8373c7a5fecf3895b1edf1b))
- Widened Pi peer dependency compatibility to include `^0.80.0` and added vulnerability overrides (`protobufjs`, `ws`). ([8bf9181](https://github.com/MasuRii/pi-model-discovery/commit/8bf91813e6176db85415e3da0e4d69e0f944d468))

## [0.2.1] - 2026-06-16

### Changed
- Improved model catalog command display with richer metadata columns and aligned model registration output.
- Enhanced enrichment merger to handle additional model metadata fields and fallback defaults.

## [0.2.0] - 2026-06-01

### Added
- Added cache replacement retries for transient file access failures.
- Added cache-only startup support, scheduled bootstrap/deferred background refresh behavior, and stale-cache handling for reasoning metadata gaps.
- Added enrichment metadata for OpenAI reasoning compatibility and Huashang free model coverage.

### Changed
- Read hidden-provider configuration directly from static config instead of dynamically importing multi-auth.
- Widened Pi peer dependency compatibility to include Pi 0.77.x and 0.78.x.

## [0.1.0] - 2026-05-27

### Added
- Prepared `pi-model-discovery` package metadata, README, changelog, license, package ignore rules, and local-extension git readiness for public release review.
- Added dynamic provider model discovery, metadata enrichment, cache-first registration, and `/pi-model-discovery` catalog command support.
- Added file-gated debug logging under the extension-local `debug/` directory when `config.json` sets `debug` to `true`.
