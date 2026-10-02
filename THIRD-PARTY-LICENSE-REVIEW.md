# Third-party notice preparation

Updated October 1, 2026. Public release remains blocked by upstream redistribution permission and the other gates in PUBLIC-RELEASE-STATUS.md. This record describes preserved files and provenance; it is not a clearance to distribute the application.

The installed dependency inventory contains 308 production packages/peers. Fourteen installed packages lacked a license text. Eight now have supplemental texts tied to recorded sources, leaving six without a preserved text. The inventory also lists 46 unresolved optional/peer references; many concern other platforms, and a reference alone does not prove a component is shipped.

## Preserved supplemental texts

| Package | Source and distinction |
| --- | --- |
| @bufbuild/protobuf 2.15.0 | [Apache license at the npm-reported source commit](https://raw.githubusercontent.com/bufbuild/protobuf-es/f72f5295c853b7be8c0828f350e4f2803c8afdde/LICENSE), plus the complete leading [BSD attribution in varint.ts](https://raw.githubusercontent.com/bufbuild/protobuf-es/f72f5295c853b7be8c0828f350e4f2803c8afdde/packages/protobuf/src/wire/varint.ts). Both were preserved. |
| @cfworker/json-schema 4.1.1 | [MIT text at the npm-reported source commit](https://raw.githubusercontent.com/cfworker/cfworker/5409fdc2bd144f68e8b28c61c71fcb16600000a6/LICENSE.md). |
| @connectrpc/connect 2.2.0 | [Apache text at the npm-reported source commit](https://raw.githubusercontent.com/connectrpc/connect-es/378bb8fde1209afc3ab6a9b0aa97c00d0db58c24/LICENSE). |
| @connectrpc/connect-web 2.2.0 | Same repository/release commit and license text as connect above. |
| @react-three/fiber 9.8.1 | [MIT text at the npm-reported source commit](https://raw.githubusercontent.com/pmndrs/react-three-fiber/53ec672ac4a7189711766b87ece18889abbb32d4/LICENSE). |
| draco3d 1.5.7 | [License and additional attribution at the npm-reported source commit](https://raw.githubusercontent.com/google/draco/8786740086a9f4d83f44aa83badfbea4dce7a1b5/LICENSE). The complete file was preserved. |
| @next/env 16.3.6 | Installed next 16.3.6 monorepo root MIT license. The subpackage's exact npm release metadata also declares MIT. This is shared-root provenance, rather than a license shipped inside the subpackage. |
| @next/swc-win32-x64-msvc 16.3.6 | Same-version Next.js root MIT text with the same distinction. Coverage of compiled Rust/vendor components remains part of release review. |

Sources are pinned in scripts/licenses/packages/PROVENANCE.json. Build preparation verifies each cached text's SHA256, copies it only for the matching package name/version, and requires no license-network fetch. The packaged resources/notices/PROVENANCE.json preserves the references and hashes. Delivery verification checks that all nine supplemental texts are listed in the inventory and match their recorded hashes.

Git attributes preserve the cached text bytes on Windows checkouts. No copyright holder, copyright year or upstream application license was invented.

## Unresolved text/provenance

| Package | Exact npm metadata | What remains unresolved |
| --- | --- | --- |
| @composio/client 2.0.0-rc.8 | [Apache-2.0 metadata](https://registry.npmjs.org/%40composio%2Fclient/2.0.0-rc.8) | The reported repository/source commit was unavailable (404); the installed package contains no license text. |
| @mediapipe/tasks-vision 0.10.17 | [Apache-2.0 metadata](https://registry.npmjs.org/%40mediapipe%2Ftasks-vision/0.10.17) | No repository/source commit is supplied by that npm metadata; an accessible license at the exact version tag was not found. No latest-branch license was substituted. |
| client-only 0.0.1 | [MIT metadata](https://registry.npmjs.org/client-only/0.0.1) | No repository/source commit or installed license text is supplied. |
| server-only 0.0.1 | [MIT metadata](https://registry.npmjs.org/server-only/0.0.1) | Same provenance gap as client-only. |
| maath 0.10.8 | [MIT metadata](https://registry.npmjs.org/maath/0.10.8) | The official [release](https://github.com/pmndrs/math/releases/tag/maath%400.10.8) was located, but its source tree contains no license text. |
| stats-gl 2.4.2 | [MIT metadata](https://registry.npmjs.org/stats-gl/2.4.2) | The npm-reported source commit is available, but its tree contains no license text. |

SPDX metadata remains in the inventory. A missing text does not by itself prove that a package is unlicensed; it means this audit has not supplied that text and its provenance. The publisher/reviewer needs to determine which components are shipped, the required notices for them, and the applicable permission. The installed inventory is broader than the traced standalone server; compiled client/server chunks also need consideration.

## Other preserved notices

The candidate retains Electron's root notices, credits from the exact bundled Chromium executable, available installed dependency LICENSE/NOTICE/COPYING files, and Geist/JetBrains Mono font license texts. These third-party materials do not license the upstream Open Dot application.

Pinned source references and hashes are preserved in scripts/licenses/packages/PROVENANCE.json. Build preparation writes the installed inventory to .desktop/notices/packages.json and copies the provenance into the packaged resources/notices directory. The fetch diagnostics and local binary/archive verification record remain outside this source contribution.
