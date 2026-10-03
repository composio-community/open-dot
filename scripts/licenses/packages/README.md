# Supplemental dependency notices

These cached texts fill gaps in the installed npm packages. Builds copy them only for the exact package name/version in PROVENANCE.json and verify their SHA256 before use. Builds do not fetch license texts from the network.

Six package licenses come from the exact source commits reported by their public npm release metadata. Protobuf also includes the complete leading BSD attribution from varint.ts at that commit. The two Next.js subpackages use the installed same-version Next.js monorepo root MIT license; their npm metadata also declares MIT. Provenance records this distinction explicitly.

This supplies texts and evidence for review. It does not grant Open Dot redistribution permission, establish that every bundled component has been identified, or clear unresolved dependencies. The installed package inventory is broader than the traced server runtime and also covers client/build dependency trees.

The source-commit repository for @composio/client was unavailable, stats-gl and the maath 0.10.8 source trees contain no license text, MediaPipe 0.10.17 could not be tied to an accessible tagged license, and client-only/server-only have no source repository/commit in their npm release metadata. Their SPDX metadata is retained; license texts and provenance have not been invented.
