# Third-Party Licenses

This file lists every third-party dependency bundled into a shipped Friday
Studio artifact (the daemon, CLI, web playground, Friday Launcher,
webhook tunnel, and Studio Installer). It is generated automatically by
[`scripts/generate-third-party-licenses.sh`](scripts/generate-third-party-licenses.sh).

For dual-licensed packages we accept the first license listed in the package
metadata. Where we have made an explicit license election (e.g. jszip), the
election is recorded in [`NOTICE`](NOTICE).

Run `bash scripts/generate-third-party-licenses.sh` to regenerate after a
dependency bump.

## Go modules

Bundled into: `tools/friday-launcher`, `tools/webhook-tunnel`.

| Module | Version | License | Source |
| --- | --- | --- | --- |
| `dario.cat/mergo` | v1.0.2 | BSD-3-Clause | https://pkg.go.dev/dario.cat/mergo |
| `fyne.io/systray` | v1.12.1-0.20260116103033-9483f6fb4738 | Apache-2.0 | https://pkg.go.dev/fyne.io/systray |
| `github.com/adrg/xdg` | v0.5.3 | MIT | https://pkg.go.dev/github.com/adrg/xdg |
| `github.com/alecthomas/chroma/v2` | v2.23.1 | see source | https://pkg.go.dev/github.com/alecthomas/chroma/v2 |
| `github.com/alicebob/gopher-json` | v0.0.0-20180125190556-5a6b3ba71ee6 | see source | https://pkg.go.dev/github.com/alicebob/gopher-json |
| `github.com/alicebob/miniredis` | v2.5.0+incompatible | see source | https://pkg.go.dev/github.com/alicebob/miniredis |
| `github.com/anmitsu/go-shlex` | v0.0.0-20200514113438-38f4b401e2be | see source | https://pkg.go.dev/github.com/anmitsu/go-shlex |
| `github.com/aymanbagabas/go-pty` | v0.2.2 | MIT | https://pkg.go.dev/github.com/aymanbagabas/go-pty |
| `github.com/bahlo/generic-list-go` | v0.2.0 | see source | https://pkg.go.dev/github.com/bahlo/generic-list-go |
| `github.com/beevik/ntp` | v0.3.0 | see source | https://pkg.go.dev/github.com/beevik/ntp |
| `github.com/boltdb/bolt` | v1.3.1 | see source | https://pkg.go.dev/github.com/boltdb/bolt |
| `github.com/bradfitz/gomemcache` | v0.0.0-20190913173617-a41fca850d0b | see source | https://pkg.go.dev/github.com/bradfitz/gomemcache |
| `github.com/buger/jsonparser` | v1.1.2 | see source | https://pkg.go.dev/github.com/buger/jsonparser |
| `github.com/bytedance/gopkg` | v0.1.4 | see source | https://pkg.go.dev/github.com/bytedance/gopkg |
| `github.com/bytedance/sonic/loader` | v0.5.1 | see source | https://pkg.go.dev/github.com/bytedance/sonic/loader |
| `github.com/bytedance/sonic` | v1.15.0 | see source | https://pkg.go.dev/github.com/bytedance/sonic |
| `github.com/caarlos0/env/v11` | v11.4.0 | MIT | https://pkg.go.dev/github.com/caarlos0/env/v11 |
| `github.com/cenkalti/backoff/v4` | v4.1.3 | see source | https://pkg.go.dev/github.com/cenkalti/backoff/v4 |
| `github.com/chzyer/logex` | v1.1.10 | see source | https://pkg.go.dev/github.com/chzyer/logex |
| `github.com/chzyer/readline` | v0.0.0-20180603132655-2972be24d48e | see source | https://pkg.go.dev/github.com/chzyer/readline |
| `github.com/chzyer/test` | v0.0.0-20180213035817-a1ea475d72b1 | see source | https://pkg.go.dev/github.com/chzyer/test |
| `github.com/cloudflare/circl` | v1.1.0 | see source | https://pkg.go.dev/github.com/cloudflare/circl |
| `github.com/cloudwego/base64x` | v0.1.6 | see source | https://pkg.go.dev/github.com/cloudwego/base64x |
| `github.com/coder/websocket` | v1.8.14 | see file | https://pkg.go.dev/github.com/coder/websocket |
| `github.com/coreos/go-systemd/v22` | v22.7.0 | see source | https://pkg.go.dev/github.com/coreos/go-systemd/v22 |
| `github.com/cpuguy83/go-md2man/v2` | v2.0.7 | see source | https://pkg.go.dev/github.com/cpuguy83/go-md2man/v2 |
| `github.com/creack/pty` | v1.1.24 | MIT | https://pkg.go.dev/github.com/creack/pty |
| `github.com/DATA-DOG/go-sqlmock` | v1.3.3 | BSD-2-Clause | https://pkg.go.dev/github.com/DATA-DOG/go-sqlmock |
| `github.com/davecgh/go-spew` | v1.1.2-0.20180830191138-d8f796af33cc | ISC | https://pkg.go.dev/github.com/davecgh/go-spew |
| `github.com/dlclark/regexp2` | v1.11.5 | see source | https://pkg.go.dev/github.com/dlclark/regexp2 |
| `github.com/drone/envsubst` | v1.0.3 | MIT | https://pkg.go.dev/github.com/drone/envsubst |
| `github.com/dustin/go-humanize` | v1.0.0 | see source | https://pkg.go.dev/github.com/dustin/go-humanize |
| `github.com/ebitengine/purego` | v0.10.0 | Apache-2.0 | https://pkg.go.dev/github.com/ebitengine/purego |
| `github.com/f1bonacc1/glippy` | v1.1.0 | see source | https://pkg.go.dev/github.com/f1bonacc1/glippy |
| `github.com/f1bonacc1/go-health/v2` | v2.1.6 | MIT | https://pkg.go.dev/github.com/f1bonacc1/go-health/v2 |
| `github.com/f1bonacc1/netstat` | v1.0.2 | MIT | https://pkg.go.dev/github.com/f1bonacc1/netstat |
| `github.com/f1bonacc1/process-compose` | v1.103.0 | Apache-2.0 | https://pkg.go.dev/github.com/f1bonacc1/process-compose |
| `github.com/fatih/color` | v1.19.0 | MIT | https://pkg.go.dev/github.com/fatih/color |
| `github.com/fsnotify/fsnotify` | v1.4.7 | see source | https://pkg.go.dev/github.com/fsnotify/fsnotify |
| `github.com/gabriel-vasile/mimetype` | v1.4.13 | see source | https://pkg.go.dev/github.com/gabriel-vasile/mimetype |
| `github.com/gdamore/encoding` | v1.0.1 | Apache-2.0 | https://pkg.go.dev/github.com/gdamore/encoding |
| `github.com/gdamore/tcell/v2` | v2.13.8 | Apache-2.0 | https://pkg.go.dev/github.com/gdamore/tcell/v2 |
| `github.com/gin-contrib/sse` | v1.1.1 | see source | https://pkg.go.dev/github.com/gin-contrib/sse |
| `github.com/gin-gonic/gin` | v1.12.0 | see source | https://pkg.go.dev/github.com/gin-gonic/gin |
| `github.com/gliderlabs/ssh` | v0.1.2-0.20181113160402-cbabf5414432 | see source | https://pkg.go.dev/github.com/gliderlabs/ssh |
| `github.com/globalsign/mgo` | v0.0.0-20181015135952-eeefdecb41b8 | see source | https://pkg.go.dev/github.com/globalsign/mgo |
| `github.com/go-chi/chi/v5` | v5.2.5 | MIT | https://pkg.go.dev/github.com/go-chi/chi/v5 |
| `github.com/go-chi/cors` | v1.2.2 | MIT | https://pkg.go.dev/github.com/go-chi/cors |
| `github.com/go-co-op/gocron/v2` | v2.19.1 | MIT | https://pkg.go.dev/github.com/go-co-op/gocron/v2 |
| `github.com/go-logr/logr` | v1.4.3 | see source | https://pkg.go.dev/github.com/go-logr/logr |
| `github.com/go-ole/go-ole` | v1.3.0 | MIT | https://pkg.go.dev/github.com/go-ole/go-ole |
| `github.com/go-openapi/jsonpointer` | v0.22.5 | see source | https://pkg.go.dev/github.com/go-openapi/jsonpointer |
| `github.com/go-openapi/jsonreference` | v0.21.5 | see source | https://pkg.go.dev/github.com/go-openapi/jsonreference |
| `github.com/go-openapi/spec` | v0.22.4 | see source | https://pkg.go.dev/github.com/go-openapi/spec |
| `github.com/go-openapi/swag/conv` | v0.25.5 | see source | https://pkg.go.dev/github.com/go-openapi/swag/conv |
| `github.com/go-openapi/swag/jsonname` | v0.25.5 | see source | https://pkg.go.dev/github.com/go-openapi/swag/jsonname |
| `github.com/go-openapi/swag/jsonutils` | v0.25.5 | see source | https://pkg.go.dev/github.com/go-openapi/swag/jsonutils |
| `github.com/go-openapi/swag/loading` | v0.25.5 | see source | https://pkg.go.dev/github.com/go-openapi/swag/loading |
| `github.com/go-openapi/swag/stringutils` | v0.25.5 | see source | https://pkg.go.dev/github.com/go-openapi/swag/stringutils |
| `github.com/go-openapi/swag/typeutils` | v0.25.5 | see source | https://pkg.go.dev/github.com/go-openapi/swag/typeutils |
| `github.com/go-openapi/swag/yamlutils` | v0.25.5 | see source | https://pkg.go.dev/github.com/go-openapi/swag/yamlutils |
| `github.com/go-playground/locales` | v0.14.1 | see source | https://pkg.go.dev/github.com/go-playground/locales |
| `github.com/go-playground/universal-translator` | v0.18.1 | see source | https://pkg.go.dev/github.com/go-playground/universal-translator |
| `github.com/go-playground/validator/v10` | v10.30.2 | see source | https://pkg.go.dev/github.com/go-playground/validator/v10 |
| `github.com/go-redis/redis` | v6.15.5+incompatible | see source | https://pkg.go.dev/github.com/go-redis/redis |
| `github.com/go-task/slim-sprig/v3` | v3.0.0 | see source | https://pkg.go.dev/github.com/go-task/slim-sprig/v3 |
| `github.com/goccy/go-json` | v0.10.6 | see source | https://pkg.go.dev/github.com/goccy/go-json |
| `github.com/goccy/go-yaml` | v1.19.2 | see source | https://pkg.go.dev/github.com/goccy/go-yaml |
| `github.com/godbus/dbus/v5` | v5.1.0 | BSD-2-Clause | https://pkg.go.dev/github.com/godbus/dbus/v5 |
| `github.com/gojuno/minimock/v3` | v3.0.8 | see source | https://pkg.go.dev/github.com/gojuno/minimock/v3 |
| `github.com/golang/protobuf` | v1.2.0 | see source | https://pkg.go.dev/github.com/golang/protobuf |
| `github.com/gomodule/redigo` | v1.8.9 | see source | https://pkg.go.dev/github.com/gomodule/redigo |
| `github.com/google/go-cmp` | v0.7.0 | BSD-3-Clause | https://pkg.go.dev/github.com/google/go-cmp |
| `github.com/google/go-tpm` | v0.3.3 | see source | https://pkg.go.dev/github.com/google/go-tpm |
| `github.com/google/goexpect` | v0.0.0-20191001010744-5b6988669ffa | see source | https://pkg.go.dev/github.com/google/goexpect |
| `github.com/google/goterm` | v0.0.0-20200907032337-555d40f16ae2 | see source | https://pkg.go.dev/github.com/google/goterm |
| `github.com/google/jsonschema-go` | v0.4.2 | see source | https://pkg.go.dev/github.com/google/jsonschema-go |
| `github.com/google/pprof` | v0.0.0-20250403155104-27863c87afa6 | see source | https://pkg.go.dev/github.com/google/pprof |
| `github.com/google/uuid` | v1.6.0 | BSD-3-Clause | https://pkg.go.dev/github.com/google/uuid |
| `github.com/gorilla/websocket` | v1.5.3 | see source | https://pkg.go.dev/github.com/gorilla/websocket |
| `github.com/hashicorp/errwrap` | v1.0.0 | see source | https://pkg.go.dev/github.com/hashicorp/errwrap |
| `github.com/hashicorp/go-multierror` | v1.1.1 | see source | https://pkg.go.dev/github.com/hashicorp/go-multierror |
| `github.com/hpcloud/tail` | v1.0.0 | MIT | https://pkg.go.dev/github.com/hpcloud/tail |
| `github.com/inconshreveable/mousetrap` | v1.1.0 | see source | https://pkg.go.dev/github.com/inconshreveable/mousetrap |
| `github.com/insomniacslk/dhcp` | v0.0.0-20211209223715-7d93572ebe8e | see source | https://pkg.go.dev/github.com/insomniacslk/dhcp |
| `github.com/intel-go/cpuid` | v0.0.0-20200819041909-2aa72927c3e2 | see source | https://pkg.go.dev/github.com/intel-go/cpuid |
| `github.com/InVisionApp/go-logger` | v1.0.1 | MIT | https://pkg.go.dev/github.com/InVisionApp/go-logger |
| `github.com/invopop/jsonschema` | v0.13.0 | see source | https://pkg.go.dev/github.com/invopop/jsonschema |
| `github.com/jessevdk/go-flags` | v1.4.0 | see source | https://pkg.go.dev/github.com/jessevdk/go-flags |
| `github.com/jezek/xgb` | v1.3.0 | see source | https://pkg.go.dev/github.com/jezek/xgb |
| `github.com/joho/godotenv` | v1.5.1 | MIT | https://pkg.go.dev/github.com/joho/godotenv |
| `github.com/jonboulle/clockwork` | v0.5.0 | Apache-2.0 | https://pkg.go.dev/github.com/jonboulle/clockwork |
| `github.com/jsimonetti/rtnetlink` | v0.0.0-20201110080708-d2c240429e6c | see source | https://pkg.go.dev/github.com/jsimonetti/rtnetlink |
| `github.com/json-iterator/go` | v1.1.12 | see source | https://pkg.go.dev/github.com/json-iterator/go |
| `github.com/kaey/framebuffer` | v0.0.0-20140402104929-7b385489a1ff | see source | https://pkg.go.dev/github.com/kaey/framebuffer |
| `github.com/kevinburke/ssh_config` | v1.1.0 | see source | https://pkg.go.dev/github.com/kevinburke/ssh_config |
| `github.com/klauspost/compress` | v1.10.6 | see source | https://pkg.go.dev/github.com/klauspost/compress |
| `github.com/klauspost/cpuid/v2` | v2.3.0 | see source | https://pkg.go.dev/github.com/klauspost/cpuid/v2 |
| `github.com/klauspost/pgzip` | v1.2.4 | see source | https://pkg.go.dev/github.com/klauspost/pgzip |
| `github.com/konsorten/go-windows-terminal-sequences` | v1.0.1 | see source | https://pkg.go.dev/github.com/konsorten/go-windows-terminal-sequences |
| `github.com/kr/pretty` | v0.3.1 | MIT | https://pkg.go.dev/github.com/kr/pretty |
| `github.com/kr/pty` | v1.1.8 | see source | https://pkg.go.dev/github.com/kr/pty |
| `github.com/kr/text` | v0.2.0 | MIT | https://pkg.go.dev/github.com/kr/text |
| `github.com/KyleBanks/depth` | v1.2.1 | see source | https://pkg.go.dev/github.com/KyleBanks/depth |
| `github.com/leodido/go-urn` | v1.4.0 | see source | https://pkg.go.dev/github.com/leodido/go-urn |
| `github.com/lucasb-eyer/go-colorful` | v1.4.0 | MIT | https://pkg.go.dev/github.com/lucasb-eyer/go-colorful |
| `github.com/lufia/plan9stats` | v0.0.0-20260330125221-c963978e514e | BSD-3-Clause | https://pkg.go.dev/github.com/lufia/plan9stats |
| `github.com/mailru/easyjson` | v0.9.2 | see source | https://pkg.go.dev/github.com/mailru/easyjson |
| `github.com/mark3labs/mcp-go` | v0.46.0 | see source | https://pkg.go.dev/github.com/mark3labs/mcp-go |
| `github.com/Masterminds/semver/v3` | v3.4.0 | see source | https://pkg.go.dev/github.com/Masterminds/semver/v3 |
| `github.com/mattn/go-colorable` | v0.1.14 | MIT | https://pkg.go.dev/github.com/mattn/go-colorable |
| `github.com/mattn/go-isatty` | v0.0.20 | MIT | https://pkg.go.dev/github.com/mattn/go-isatty |
| `github.com/mattn/go-runewidth` | v0.0.16 | see source | https://pkg.go.dev/github.com/mattn/go-runewidth |
| `github.com/mattn/go-sixel` | v0.0.5 | see source | https://pkg.go.dev/github.com/mattn/go-sixel |
| `github.com/mattn/go-tty` | v0.0.3 | see source | https://pkg.go.dev/github.com/mattn/go-tty |
| `github.com/mdlayher/ethernet` | v0.0.0-20190606142754-0394541c37b7 | see source | https://pkg.go.dev/github.com/mdlayher/ethernet |
| `github.com/mdlayher/netlink` | v1.1.1 | see source | https://pkg.go.dev/github.com/mdlayher/netlink |
| `github.com/mdlayher/raw` | v0.0.0-20191009151244-50f2db8cc065 | see source | https://pkg.go.dev/github.com/mdlayher/raw |
| `github.com/modern-go/concurrent` | v0.0.0-20180306012644-bacd9c7ef1dd | see source | https://pkg.go.dev/github.com/modern-go/concurrent |
| `github.com/modern-go/reflect2` | v1.0.2 | see source | https://pkg.go.dev/github.com/modern-go/reflect2 |
| `github.com/nanmu42/limitio` | v1.0.0 | see source | https://pkg.go.dev/github.com/nanmu42/limitio |
| `github.com/onsi/ginkgo/v2` | v2.25.1 | see source | https://pkg.go.dev/github.com/onsi/ginkgo/v2 |
| `github.com/onsi/ginkgo` | v1.6.0 | MIT | https://pkg.go.dev/github.com/onsi/ginkgo |
| `github.com/onsi/gomega` | v1.38.2 | MIT | https://pkg.go.dev/github.com/onsi/gomega |
| `github.com/orangecms/go-framebuffer` | v0.0.0-20200613202404-a0700d90c330 | see source | https://pkg.go.dev/github.com/orangecms/go-framebuffer |
| `github.com/pborman/getopt/v2` | v2.1.0 | see source | https://pkg.go.dev/github.com/pborman/getopt/v2 |
| `github.com/pelletier/go-toml/v2` | v2.3.0 | see source | https://pkg.go.dev/github.com/pelletier/go-toml/v2 |
| `github.com/pierrec/lz4/v4` | v4.1.14 | see source | https://pkg.go.dev/github.com/pierrec/lz4/v4 |
| `github.com/pkg/browser` | v0.0.0-20240102092130-5ac0b6a4141c | BSD-2-Clause | https://pkg.go.dev/github.com/pkg/browser |
| `github.com/pkg/diff` | v0.0.0-20210226163009-20ebb0f2a09e | see source | https://pkg.go.dev/github.com/pkg/diff |
| `github.com/pkg/errors` | v0.9.1 | see source | https://pkg.go.dev/github.com/pkg/errors |
| `github.com/pkg/term` | v1.2.0-beta.2 | see source | https://pkg.go.dev/github.com/pkg/term |
| `github.com/pmezard/go-difflib` | v1.0.1-0.20181226105442-5d4384ee4fb2 | BSD-2-Clause | https://pkg.go.dev/github.com/pmezard/go-difflib |
| `github.com/power-devops/perfstat` | v0.0.0-20240221224432-82ca36839d55 | MIT | https://pkg.go.dev/github.com/power-devops/perfstat |
| `github.com/ProtonMail/go-crypto` | v0.0.0-20221026131551-cf6655e29de4 | see source | https://pkg.go.dev/github.com/ProtonMail/go-crypto |
| `github.com/quic-go/qpack` | v0.6.0 | see source | https://pkg.go.dev/github.com/quic-go/qpack |
| `github.com/quic-go/quic-go` | v0.59.0 | see source | https://pkg.go.dev/github.com/quic-go/quic-go |
| `github.com/rck/unit` | v0.0.3 | see source | https://pkg.go.dev/github.com/rck/unit |
| `github.com/rekby/gpt` | v0.0.0-20200219180433-a930afbc6edc | see source | https://pkg.go.dev/github.com/rekby/gpt |
| `github.com/rivo/tview` | v0.42.0 | MIT | https://pkg.go.dev/github.com/rivo/tview |
| `github.com/rivo/uniseg` | v0.4.7 | MIT | https://pkg.go.dev/github.com/rivo/uniseg |
| `github.com/robfig/cron/v3` | v3.0.1 | MIT | https://pkg.go.dev/github.com/robfig/cron/v3 |
| `github.com/rogpeppe/go-internal` | v1.14.1 | BSD-3-Clause | https://pkg.go.dev/github.com/rogpeppe/go-internal |
| `github.com/rs/xid` | v1.6.0 | see source | https://pkg.go.dev/github.com/rs/xid |
| `github.com/rs/zerolog` | v1.35.1 | MIT | https://pkg.go.dev/github.com/rs/zerolog |
| `github.com/russross/blackfriday/v2` | v2.1.0 | see source | https://pkg.go.dev/github.com/russross/blackfriday/v2 |
| `github.com/safchain/ethtool` | v0.0.0-20200218184317-f459e2d13664 | see source | https://pkg.go.dev/github.com/safchain/ethtool |
| `github.com/shirou/gopsutil/v4` | v4.26.3 | BSD-3-Clause | https://pkg.go.dev/github.com/shirou/gopsutil/v4 |
| `github.com/shirou/gopsutil` | v2.18.12+incompatible | see source | https://pkg.go.dev/github.com/shirou/gopsutil |
| `github.com/sirupsen/logrus` | v1.9.4 | MIT | https://pkg.go.dev/github.com/sirupsen/logrus |
| `github.com/soniakeys/quant` | v1.0.0 | see source | https://pkg.go.dev/github.com/soniakeys/quant |
| `github.com/spf13/cast` | v1.10.0 | see source | https://pkg.go.dev/github.com/spf13/cast |
| `github.com/spf13/cobra` | v1.10.2 | see source | https://pkg.go.dev/github.com/spf13/cobra |
| `github.com/spf13/pflag` | v1.0.10 | see source | https://pkg.go.dev/github.com/spf13/pflag |
| `github.com/StackExchange/wmi` | v0.0.0-20190523213315-cbe66965904d | see source | https://pkg.go.dev/github.com/StackExchange/wmi |
| `github.com/stoewer/go-strcase` | v1.3.1 | see source | https://pkg.go.dev/github.com/stoewer/go-strcase |
| `github.com/stretchr/objx` | v0.5.2 | see source | https://pkg.go.dev/github.com/stretchr/objx |
| `github.com/stretchr/testify` | v1.11.1 | MIT | https://pkg.go.dev/github.com/stretchr/testify |
| `github.com/swaggo/files` | v1.0.1 | see source | https://pkg.go.dev/github.com/swaggo/files |
| `github.com/swaggo/gin-swagger` | v1.6.1 | see source | https://pkg.go.dev/github.com/swaggo/gin-swagger |
| `github.com/swaggo/swag` | v1.16.6 | see source | https://pkg.go.dev/github.com/swaggo/swag |
| `github.com/tklauser/go-sysconf` | v0.3.16 | BSD-3-Clause | https://pkg.go.dev/github.com/tklauser/go-sysconf |
| `github.com/tklauser/numcpus` | v0.11.0 | Apache-2.0 | https://pkg.go.dev/github.com/tklauser/numcpus |
| `github.com/twitchyliquid64/golang-asm` | v0.15.1 | see source | https://pkg.go.dev/github.com/twitchyliquid64/golang-asm |
| `github.com/u-root/gobusybox/src` | v0.0.0-20221229083637-46b2883a7f90 | BSD-3-Clause | https://pkg.go.dev/github.com/u-root/gobusybox/src |
| `github.com/u-root/iscsinl` | v0.1.1-0.20210528121423-84c32645822a | see source | https://pkg.go.dev/github.com/u-root/iscsinl |
| `github.com/u-root/prompt` | v0.0.0-20221110083427-a2ad3c8339a8 | see source | https://pkg.go.dev/github.com/u-root/prompt |
| `github.com/u-root/u-root` | v0.11.0 | BSD-3-Clause | https://pkg.go.dev/github.com/u-root/u-root |
| `github.com/u-root/uio` | v0.0.0-20220204230159-dac05f7d2cb4 | see source | https://pkg.go.dev/github.com/u-root/uio |
| `github.com/ugorji/go/codec` | v1.3.1 | see source | https://pkg.go.dev/github.com/ugorji/go/codec |
| `github.com/ulikunitz/xz` | v0.5.8 | see source | https://pkg.go.dev/github.com/ulikunitz/xz |
| `github.com/vishvananda/netlink` | v1.1.1-0.20211118161826-650dca95af54 | see source | https://pkg.go.dev/github.com/vishvananda/netlink |
| `github.com/vishvananda/netns` | v0.0.0-20210104183010-2eb08e3e575f | see source | https://pkg.go.dev/github.com/vishvananda/netns |
| `github.com/vtolstov/go-ioctl` | v0.0.0-20151206205506-6be9cced4810 | see source | https://pkg.go.dev/github.com/vtolstov/go-ioctl |
| `github.com/wk8/go-ordered-map/v2` | v2.1.8 | see source | https://pkg.go.dev/github.com/wk8/go-ordered-map/v2 |
| `github.com/yosida95/uritemplate/v3` | v3.0.2 | see source | https://pkg.go.dev/github.com/yosida95/uritemplate/v3 |
| `github.com/yuin/goldmark` | v1.4.13 | see source | https://pkg.go.dev/github.com/yuin/goldmark |
| `github.com/yuin/gopher-lua` | v0.0.0-20190514113301-1cd887cd7036 | see source | https://pkg.go.dev/github.com/yuin/gopher-lua |
| `github.com/yusufpapurcu/wmi` | v1.2.4 | MIT | https://pkg.go.dev/github.com/yusufpapurcu/wmi |
| `github.com/zaffka/mongodb-boltdb-mock` | v0.0.0-20221014194232-b4bb03fbe3a0 | see source | https://pkg.go.dev/github.com/zaffka/mongodb-boltdb-mock |
| `go.mongodb.org/mongo-driver/v2` | v2.5.0 | see source | https://pkg.go.dev/go.mongodb.org/mongo-driver/v2 |
| `go.uber.org/automaxprocs` | v1.6.0 | see source | https://pkg.go.dev/go.uber.org/automaxprocs |
| `go.uber.org/goleak` | v1.3.0 | MIT | https://pkg.go.dev/go.uber.org/goleak |
| `go.yaml.in/yaml/v3` | v3.0.4 | Apache-2.0 | https://pkg.go.dev/go.yaml.in/yaml/v3 |
| `golang.org/x/arch` | v0.25.0 | see source | https://pkg.go.dev/golang.org/x/arch |
| `golang.org/x/crypto` | v0.49.0 | BSD-3-Clause | https://pkg.go.dev/golang.org/x/crypto |
| `golang.org/x/mod` | v0.34.0 | see source | https://pkg.go.dev/golang.org/x/mod |
| `golang.org/x/net` | v0.52.0 | BSD-3-Clause | https://pkg.go.dev/golang.org/x/net |
| `golang.org/x/sync` | v0.20.0 | see source | https://pkg.go.dev/golang.org/x/sync |
| `golang.org/x/sys` | v0.43.0 | BSD-3-Clause | https://pkg.go.dev/golang.org/x/sys |
| `golang.org/x/term` | v0.41.0 | BSD-3-Clause | https://pkg.go.dev/golang.org/x/term |
| `golang.org/x/text` | v0.35.0 | BSD-3-Clause | https://pkg.go.dev/golang.org/x/text |
| `golang.org/x/tools` | v0.43.0 | see source | https://pkg.go.dev/golang.org/x/tools |
| `golang.org/x/xerrors` | v0.0.0-20220609144429-65e65417b02f | see source | https://pkg.go.dev/golang.org/x/xerrors |
| `google.golang.org/grpc` | v1.27.1 | see source | https://pkg.go.dev/google.golang.org/grpc |
| `google.golang.org/protobuf` | v1.36.11 | see source | https://pkg.go.dev/google.golang.org/protobuf |
| `gopkg.in/check.v1` | v1.0.0-20201130134442-10cb98267c6c | BSD-2-Clause | https://pkg.go.dev/gopkg.in/check.v1 |
| `gopkg.in/fsnotify.v1` | v1.4.7 | BSD-3-Clause | https://pkg.go.dev/gopkg.in/fsnotify.v1 |
| `gopkg.in/natefinch/lumberjack.v2` | v2.2.1 | MIT | https://pkg.go.dev/gopkg.in/natefinch/lumberjack.v2 |
| `gopkg.in/tomb.v1` | v1.0.0-20141024135613-dd632973f1e7 | BSD-3-Clause | https://pkg.go.dev/gopkg.in/tomb.v1 |
| `gopkg.in/yaml.v1` | v1.0.0-20140924161607-9f9df34309c0 | see source | https://pkg.go.dev/gopkg.in/yaml.v1 |
| `gopkg.in/yaml.v2` | v2.2.8 | see source | https://pkg.go.dev/gopkg.in/yaml.v2 |
| `gopkg.in/yaml.v3` | v3.0.1 | Apache-2.0 | https://pkg.go.dev/gopkg.in/yaml.v3 |
| `howett.net/plist` | v1.0.1 | BSD-3-Clause | https://pkg.go.dev/howett.net/plist |
| `mvdan.cc/sh/v3` | v3.4.1 | see source | https://pkg.go.dev/mvdan.cc/sh/v3 |
| `pack.ag/tftp` | v1.0.1-0.20181129014014-07909dfbde3c | see source | https://pkg.go.dev/pack.ag/tftp |
| `src.elv.sh` | v0.16.0-rc1.0.20220116211855-fda62502ad7f | see source | https://pkg.go.dev/src.elv.sh |

## Rust crates

Bundled into: `apps/studio-installer` (Tauri installer binary).

| Crate | Version | License | Source |
| --- | --- | --- | --- |
| `adler2` | 2.0.1 | 0BSD OR Apache-2.0 OR MIT | https://github.com/oyvindln/adler2 |
| `aes` | 0.8.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/block-ciphers |
| `aho-corasick` | 1.1.4 | MIT OR Unlicense | https://github.com/BurntSushi/aho-corasick |
| `alloc-no-stdlib` | 2.0.4 | BSD-3-Clause | https://github.com/dropbox/rust-alloc-no-stdlib |
| `alloc-stdlib` | 0.2.2 | BSD-3-Clause | https://github.com/dropbox/rust-alloc-no-stdlib |
| `android_system_properties` | 0.1.5 | Apache-2.0 OR MIT | https://github.com/nical/android_system_properties |
| `anyhow` | 1.0.102 | Apache-2.0 OR MIT | https://github.com/dtolnay/anyhow |
| `async-broadcast` | 0.7.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-broadcast |
| `async-channel` | 2.5.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-channel |
| `async-executor` | 1.14.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-executor |
| `async-io` | 2.6.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-io |
| `async-lock` | 3.4.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-lock |
| `async-process` | 2.5.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-process |
| `async-recursion` | 1.1.1 | Apache-2.0 OR MIT | https://github.com/dcchut/async-recursion |
| `async-signal` | 0.2.14 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-signal |
| `async-task` | 4.7.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/async-task |
| `async-trait` | 0.1.89 | Apache-2.0 OR MIT | https://github.com/dtolnay/async-trait |
| `atk-sys` | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| `atk` | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| `atomic-waker` | 1.1.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/atomic-waker |
| `autocfg` | 1.5.0 | Apache-2.0 OR MIT | https://github.com/cuviper/autocfg |
| `base64` | 0.21.7 | Apache-2.0 OR MIT | https://github.com/marshallpierce/rust-base64 |
| `base64` | 0.22.1 | Apache-2.0 OR MIT | https://github.com/marshallpierce/rust-base64 |
| `base64ct` | 1.8.3 | Apache-2.0 OR MIT | https://github.com/RustCrypto/formats |
| `bit-set` | 0.8.0 | Apache-2.0 OR MIT | https://github.com/contain-rs/bit-set |
| `bit-vec` | 0.8.0 | Apache-2.0 OR MIT | https://github.com/contain-rs/bit-vec |
| `bitflags` | 1.3.2 | Apache-2.0 OR MIT | https://github.com/bitflags/bitflags |
| `bitflags` | 2.11.1 | Apache-2.0 OR MIT | https://github.com/bitflags/bitflags |
| `block-buffer` | 0.10.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| `block2` | 0.6.2 | MIT | https://github.com/madsmtm/objc2 |
| `blocking` | 1.6.2 | Apache-2.0 OR MIT | https://github.com/smol-rs/blocking |
| `brotli-decompressor` | 5.0.0 | BSD-3-Clause OR MIT | https://github.com/dropbox/rust-brotli-decompressor |
| `brotli` | 8.0.2 | BSD-3-Clause AND MIT | https://github.com/dropbox/rust-brotli |
| `bumpalo` | 3.20.2 | Apache-2.0 OR MIT | https://github.com/fitzgen/bumpalo |
| `bytemuck` | 1.25.0 | Apache-2.0 OR MIT OR Zlib | https://github.com/Lokathor/bytemuck |
| `byteorder` | 1.5.0 | MIT OR Unlicense | https://github.com/BurntSushi/byteorder |
| `bytes` | 1.11.1 | MIT | https://github.com/tokio-rs/bytes |
| `bzip2-sys` | 0.1.13+1.0.8 | Apache-2.0 OR MIT | https://github.com/alexcrichton/bzip2-rs |
| `bzip2` | 0.4.4 | Apache-2.0 OR MIT | https://github.com/alexcrichton/bzip2-rs |
| `cairo-rs` | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `cairo-sys-rs` | 0.18.2 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `camino` | 1.2.2 | Apache-2.0 OR MIT | https://github.com/camino-rs/camino |
| `cargo_metadata` | 0.19.2 | MIT | https://github.com/oli-obk/cargo_metadata |
| `cargo_toml` | 0.22.3 | Apache-2.0 OR MIT | https://gitlab.com/lib.rs/cargo_toml |
| `cargo-platform` | 0.1.9 | Apache-2.0 OR MIT | https://github.com/rust-lang/cargo |
| `cc` | 1.2.60 | Apache-2.0 OR MIT | https://github.com/rust-lang/cc-rs |
| `cesu8` | 1.1.0 | Apache-2.0 OR MIT | https://github.com/emk/cesu8-rs |
| `cfb` | 0.7.3 | MIT | https://github.com/mdsteele/rust-cfb |
| `cfg_aliases` | 0.2.1 | MIT | https://github.com/katharostech/cfg_aliases |
| `cfg-expr` | 0.15.8 | Apache-2.0 OR MIT | https://github.com/EmbarkStudios/cfg-expr |
| `cfg-if` | 1.0.4 | Apache-2.0 OR MIT | https://github.com/rust-lang/cfg-if |
| `chrono` | 0.4.44 | Apache-2.0 OR MIT | https://github.com/chronotope/chrono |
| `cipher` | 0.4.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| `combine` | 4.6.7 | MIT | https://github.com/Marwes/combine |
| `concurrent-queue` | 2.5.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/concurrent-queue |
| `constant_time_eq` | 0.1.5 | CC0-1.0 | https://github.com/cesarb/constant_time_eq |
| `convert_case` | 0.4.0 | MIT | https://github.com/rutrum/convert-case |
| `cookie` | 0.18.1 | Apache-2.0 OR MIT | https://github.com/SergioBenitez/cookie-rs |
| `core-foundation-sys` | 0.8.7 | Apache-2.0 OR MIT | https://github.com/servo/core-foundation-rs |
| `core-foundation` | 0.10.1 | Apache-2.0 OR MIT | https://github.com/servo/core-foundation-rs |
| `core-graphics-types` | 0.2.0 | Apache-2.0 OR MIT | https://github.com/servo/core-foundation-rs |
| `core-graphics` | 0.25.0 | Apache-2.0 OR MIT | https://github.com/servo/core-foundation-rs |
| `cpufeatures` | 0.2.17 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| `crc32fast` | 1.5.0 | Apache-2.0 OR MIT | https://github.com/srijs/rust-crc32fast |
| `crossbeam-channel` | 0.5.15 | Apache-2.0 OR MIT | https://github.com/crossbeam-rs/crossbeam |
| `crossbeam-utils` | 0.8.21 | Apache-2.0 OR MIT | https://github.com/crossbeam-rs/crossbeam |
| `crypto-common` | 0.1.7 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| `cssparser-macros` | 0.6.1 | MPL-2.0 | https://github.com/servo/rust-cssparser |
| `cssparser` | 0.29.6 | MPL-2.0 | https://github.com/servo/rust-cssparser |
| `cssparser` | 0.36.0 | MPL-2.0 | https://github.com/servo/rust-cssparser |
| `ctor` | 0.2.9 | Apache-2.0 OR MIT | https://github.com/mmastrac/rust-ctor |
| `darling_core` | 0.23.0 | MIT | https://github.com/TedDriggs/darling |
| `darling_macro` | 0.23.0 | MIT | https://github.com/TedDriggs/darling |
| `darling` | 0.23.0 | MIT | https://github.com/TedDriggs/darling |
| `deranged` | 0.5.8 | Apache-2.0 OR MIT | https://github.com/jhpratt/deranged |
| `derive_more-impl` | 2.1.1 | MIT | https://github.com/JelteF/derive_more |
| `derive_more` | 0.99.20 | MIT | https://github.com/JelteF/derive_more |
| `derive_more` | 2.1.1 | MIT | https://github.com/JelteF/derive_more |
| `digest` | 0.10.7 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits |
| `dirs-sys` | 0.4.1 | Apache-2.0 OR MIT | https://github.com/dirs-dev/dirs-sys-rs |
| `dirs-sys` | 0.5.0 | Apache-2.0 OR MIT | https://github.com/dirs-dev/dirs-sys-rs |
| `dirs` | 5.0.1 | Apache-2.0 OR MIT | https://github.com/soc/dirs-rs |
| `dirs` | 6.0.0 | Apache-2.0 OR MIT | https://github.com/soc/dirs-rs |
| `dispatch2` | 0.3.1 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `displaydoc` | 0.2.5 | Apache-2.0 OR MIT | https://github.com/yaahc/displaydoc |
| `dlopen2_derive` | 0.4.3 | MIT | https://github.com/OpenByteDev/dlopen2 |
| `dlopen2` | 0.8.2 | MIT | https://github.com/OpenByteDev/dlopen2 |
| `dom_query` | 0.27.0 | MIT | https://github.com/niklak/dom_query |
| `dpi` | 0.1.2 | Apache-2.0 AND MIT | https://github.com/rust-windowing/winit |
| `dtoa-short` | 0.3.5 | MPL-2.0 | https://github.com/upsuper/dtoa-short |
| `dtoa` | 1.0.11 | Apache-2.0 OR MIT | https://github.com/dtolnay/dtoa |
| `dunce` | 1.0.5 | Apache-2.0 OR CC0-1.0 OR MIT-0 | https://gitlab.com/kornelski/dunce |
| `dyn-clone` | 1.0.20 | Apache-2.0 OR MIT | https://github.com/dtolnay/dyn-clone |
| `either` | 1.15.0 | Apache-2.0 OR MIT | https://github.com/rayon-rs/either |
| `embed_plist` | 1.2.2 | Apache-2.0 OR MIT | https://github.com/nvzqz/embed-plist-rs |
| `embed-resource` | 3.0.8 | MIT | https://github.com/nabijaczleweli/rust-embed-resource |
| `endi` | 1.1.1 | MIT | https://github.com/zeenix/endi |
| `enumflags2_derive` | 0.7.12 | Apache-2.0 OR MIT | https://github.com/meithecatte/enumflags2 |
| `enumflags2` | 0.7.12 | Apache-2.0 OR MIT | https://github.com/meithecatte/enumflags2 |
| `equivalent` | 1.0.2 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/equivalent |
| `erased-serde` | 0.4.10 | Apache-2.0 OR MIT | https://github.com/dtolnay/erased-serde |
| `errno` | 0.3.14 | Apache-2.0 OR MIT | https://github.com/lambda-fairy/rust-errno |
| `event-listener-strategy` | 0.5.4 | Apache-2.0 OR MIT | https://github.com/smol-rs/event-listener-strategy |
| `event-listener` | 5.4.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/event-listener |
| `fastrand` | 2.4.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/fastrand |
| `fdeflate` | 0.3.7 | Apache-2.0 OR MIT | https://github.com/image-rs/fdeflate |
| `field-offset` | 0.3.6 | Apache-2.0 OR MIT | https://github.com/Diggsey/rust-field-offset |
| `filetime` | 0.2.27 | Apache-2.0 OR MIT | https://github.com/alexcrichton/filetime |
| `find-msvc-tools` | 0.1.9 | Apache-2.0 OR MIT | https://github.com/rust-lang/cc-rs |
| `flate2` | 1.1.9 | Apache-2.0 OR MIT | https://github.com/rust-lang/flate2-rs |
| `fnv` | 1.0.7 | Apache-2.0 OR MIT | https://github.com/servo/rust-fnv |
| `foldhash` | 0.1.5 | Zlib | https://github.com/orlp/foldhash |
| `foldhash` | 0.2.0 | Zlib | https://github.com/orlp/foldhash |
| `foreign-types-macros` | 0.2.3 | Apache-2.0 OR MIT | https://github.com/sfackler/foreign-types |
| `foreign-types-shared` | 0.3.1 | Apache-2.0 OR MIT | https://github.com/sfackler/foreign-types |
| `foreign-types` | 0.5.0 | Apache-2.0 OR MIT | https://github.com/sfackler/foreign-types |
| `form_urlencoded` | 1.2.2 | Apache-2.0 OR MIT | https://github.com/servo/rust-url |
| `futf` | 0.1.5 | Apache-2.0 OR MIT | https://github.com/servo/futf |
| `futures-channel` | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| `futures-core` | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| `futures-executor` | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| `futures-io` | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| `futures-lite` | 2.6.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/futures-lite |
| `futures-macro` | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| `futures-sink` | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| `futures-task` | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| `futures-util` | 0.3.32 | Apache-2.0 OR MIT | https://github.com/rust-lang/futures-rs |
| `fxhash` | 0.2.1 | Apache-2.0 OR MIT | https://github.com/cbreeden/fxhash |
| `gdk-pixbuf-sys` | 0.18.0 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `gdk-pixbuf` | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `gdk-sys` | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| `gdk` | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| `gdkwayland-sys` | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| `gdkx11-sys` | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| `gdkx11` | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| `generic-array` | 0.14.7 | MIT | https://github.com/fizyk20/generic-array.git |
| `gethostname` | 1.1.0 | Apache-2.0 | https://codeberg.org/swsnr/gethostname.rs.git |
| `getrandom` | 0.1.16 | Apache-2.0 OR MIT | https://github.com/rust-random/getrandom |
| `getrandom` | 0.2.17 | Apache-2.0 OR MIT | https://github.com/rust-random/getrandom |
| `getrandom` | 0.3.4 | Apache-2.0 OR MIT | https://github.com/rust-random/getrandom |
| `getrandom` | 0.4.2 | Apache-2.0 OR MIT | https://github.com/rust-random/getrandom |
| `gio-sys` | 0.18.1 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `gio` | 0.18.4 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `glib-macros` | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `glib-sys` | 0.18.1 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `glib` | 0.18.5 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `glob` | 0.3.3 | Apache-2.0 OR MIT | https://github.com/rust-lang/glob |
| `gobject-sys` | 0.18.0 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `gtk-sys` | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| `gtk` | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| `gtk3-macros` | 0.18.2 | MIT | https://github.com/gtk-rs/gtk3-rs |
| `hashbrown` | 0.12.3 | Apache-2.0 OR MIT | https://github.com/rust-lang/hashbrown |
| `hashbrown` | 0.15.5 | Apache-2.0 OR MIT | https://github.com/rust-lang/hashbrown |
| `hashbrown` | 0.17.0 | Apache-2.0 OR MIT | https://github.com/rust-lang/hashbrown |
| `heck` | 0.4.1 | Apache-2.0 OR MIT | https://github.com/withoutboats/heck |
| `heck` | 0.5.0 | Apache-2.0 OR MIT | https://github.com/withoutboats/heck |
| `hermit-abi` | 0.5.2 | Apache-2.0 OR MIT | https://github.com/hermit-os/hermit-rs |
| `hex` | 0.4.3 | Apache-2.0 OR MIT | https://github.com/KokaKiwi/rust-hex |
| `hmac` | 0.12.1 | Apache-2.0 OR MIT | https://github.com/RustCrypto/MACs |
| `home` | 0.5.12 | Apache-2.0 OR MIT | https://github.com/rust-lang/cargo |
| `html5ever` | 0.29.1 | Apache-2.0 OR MIT | https://github.com/servo/html5ever |
| `html5ever` | 0.38.0 | Apache-2.0 OR MIT | https://github.com/servo/html5ever |
| `http-body-util` | 0.1.3 | MIT | https://github.com/hyperium/http-body |
| `http-body` | 1.0.1 | MIT | https://github.com/hyperium/http-body |
| `http` | 1.4.0 | Apache-2.0 OR MIT | https://github.com/hyperium/http |
| `httparse` | 1.10.1 | Apache-2.0 OR MIT | https://github.com/seanmonstar/httparse |
| `hyper-rustls` | 0.27.9 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/hyper-rustls |
| `hyper-util` | 0.1.20 | MIT | https://github.com/hyperium/hyper-util |
| `hyper` | 1.9.0 | MIT | https://github.com/hyperium/hyper |
| `iana-time-zone-haiku` | 0.1.2 | Apache-2.0 OR MIT | https://github.com/strawlab/iana-time-zone |
| `iana-time-zone` | 0.1.65 | Apache-2.0 OR MIT | https://github.com/strawlab/iana-time-zone |
| `ico` | 0.5.0 | MIT | https://github.com/mdsteele/rust-ico |
| `icu_collections` | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_locale_core` | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_normalizer_data` | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_normalizer` | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_properties_data` | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_properties` | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `icu_provider` | 2.2.0 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `id-arena` | 2.3.0 | Apache-2.0 OR MIT | https://github.com/fitzgen/id-arena |
| `ident_case` | 1.0.1 | Apache-2.0 OR MIT | https://github.com/TedDriggs/ident_case |
| `idna_adapter` | 1.2.1 | Apache-2.0 OR MIT | https://github.com/hsivonen/idna_adapter |
| `idna` | 1.1.0 | Apache-2.0 OR MIT | https://github.com/servo/rust-url/ |
| `indexmap` | 1.9.3 | Apache-2.0 OR MIT | https://github.com/bluss/indexmap |
| `indexmap` | 2.14.0 | Apache-2.0 OR MIT | https://github.com/indexmap-rs/indexmap |
| `infer` | 0.19.0 | MIT | https://github.com/bojand/infer |
| `inout` | 0.1.4 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| `ipnet` | 2.12.0 | Apache-2.0 OR MIT | https://github.com/krisprice/ipnet |
| `iri-string` | 0.7.12 | Apache-2.0 OR MIT | https://github.com/lo48576/iri-string |
| `is-docker` | 0.2.0 | MIT | https://github.com/TheLarkInn/is-docker |
| `is-wsl` | 0.4.0 | MIT | https://github.com/TheLarkInn/is-wsl |
| `itoa` | 1.0.18 | Apache-2.0 OR MIT | https://github.com/dtolnay/itoa |
| `javascriptcore-rs-sys` | 1.1.1 | MIT | https://github.com/tauri-apps/javascriptcore-rs |
| `javascriptcore-rs` | 1.1.2 | MIT | https://github.com/tauri-apps/javascriptcore-rs |
| `jni-sys-macros` | 0.4.1 | Apache-2.0 OR MIT | https://github.com/jni-rs/jni-sys |
| `jni-sys` | 0.3.1 | Apache-2.0 OR MIT | https://github.com/jni-rs/jni-sys |
| `jni-sys` | 0.4.1 | Apache-2.0 OR MIT | https://github.com/jni-rs/jni-sys |
| `jni` | 0.21.1 | Apache-2.0 OR MIT | https://github.com/jni-rs/jni-rs |
| `jobserver` | 0.1.34 | Apache-2.0 OR MIT | https://github.com/rust-lang/jobserver-rs |
| `js-sys` | 0.3.95 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys |
| `json-patch` | 3.0.1 | Apache-2.0 OR MIT | https://github.com/idubrov/json-patch |
| `jsonptr` | 0.6.3 | Apache-2.0 OR MIT | https://github.com/chanced/jsonptr |
| `keyboard-types` | 0.7.0 | Apache-2.0 OR MIT | https://github.com/pyfisch/keyboard-types |
| `kuchikiki` | 0.8.8-speedreader | MIT | https://github.com/brave/kuchikiki |
| `leb128fmt` | 0.1.0 | Apache-2.0 OR MIT | https://github.com/bluk/leb128fmt |
| `libappindicator-sys` | 0.9.0 | Apache-2.0 OR MIT | n/a |
| `libappindicator` | 0.9.0 | Apache-2.0 OR MIT | n/a |
| `libc` | 0.2.186 | Apache-2.0 OR MIT | https://github.com/rust-lang/libc |
| `libloading` | 0.7.4 | ISC | https://github.com/nagisa/rust_libloading/ |
| `libredox` | 0.1.16 | MIT | https://gitlab.redox-os.org/redox-os/libredox.git |
| `linux-raw-sys` | 0.12.1 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/sunfishcode/linux-raw-sys |
| `linux-raw-sys` | 0.4.15 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/sunfishcode/linux-raw-sys |
| `litemap` | 0.8.2 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `lock_api` | 0.4.14 | Apache-2.0 OR MIT | https://github.com/Amanieu/parking_lot |
| `log` | 0.4.29 | Apache-2.0 OR MIT | https://github.com/rust-lang/log |
| `lru-slab` | 0.1.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/Ralith/lru-slab |
| `mac` | 0.1.1 | Apache-2.0 OR MIT | https://github.com/reem/rust-mac.git |
| `markup5ever` | 0.14.1 | Apache-2.0 OR MIT | https://github.com/servo/html5ever |
| `markup5ever` | 0.38.0 | Apache-2.0 OR MIT | https://github.com/servo/html5ever |
| `match_token` | 0.1.0 | Apache-2.0 OR MIT | https://github.com/servo/html5ever |
| `matches` | 0.1.10 | MIT | https://github.com/SimonSapin/rust-std-candidates |
| `memchr` | 2.8.0 | MIT OR Unlicense | https://github.com/BurntSushi/memchr |
| `memoffset` | 0.9.1 | MIT | https://github.com/Gilnaa/memoffset |
| `mime` | 0.3.17 | Apache-2.0 OR MIT | https://github.com/hyperium/mime |
| `miniz_oxide` | 0.8.9 | Apache-2.0 OR MIT OR Zlib | https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| `mio` | 1.2.0 | MIT | https://github.com/tokio-rs/mio |
| `muda` | 0.17.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/muda |
| `ndk-context` | 0.1.1 | Apache-2.0 OR MIT | https://github.com/rust-windowing/android-ndk-rs |
| `ndk-sys` | 0.6.0+11769913 | Apache-2.0 OR MIT | https://github.com/rust-mobile/ndk |
| `ndk` | 0.9.0 | Apache-2.0 OR MIT | https://github.com/rust-mobile/ndk |
| `new_debug_unreachable` | 1.0.6 | MIT | https://github.com/mbrubeck/rust-debug-unreachable |
| `nix` | 0.30.1 | MIT | https://github.com/nix-rust/nix |
| `nodrop` | 0.1.14 | Apache-2.0 OR MIT | https://github.com/bluss/arrayvec |
| `num_enum_derive` | 0.7.6 | Apache-2.0 OR BSD-3-Clause OR MIT | https://github.com/illicitonion/num_enum |
| `num_enum` | 0.7.6 | Apache-2.0 OR BSD-3-Clause OR MIT | https://github.com/illicitonion/num_enum |
| `num-conv` | 0.2.1 | Apache-2.0 OR MIT | https://github.com/jhpratt/num-conv |
| `num-traits` | 0.2.19 | Apache-2.0 OR MIT | https://github.com/rust-num/num-traits |
| `objc2-app-kit` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-cloud-kit` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-core-data` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-core-foundation` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-core-graphics` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-core-image` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-core-location` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-core-text` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-encode` | 4.1.0 | MIT | https://github.com/madsmtm/objc2 |
| `objc2-exception-helper` | 0.1.1 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-foundation` | 0.3.2 | MIT | https://github.com/madsmtm/objc2 |
| `objc2-io-surface` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-quartz-core` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-ui-kit` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-user-notifications` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2-web-kit` | 0.3.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/madsmtm/objc2 |
| `objc2` | 0.6.4 | MIT | https://github.com/madsmtm/objc2 |
| `once_cell` | 1.21.4 | Apache-2.0 OR MIT | https://github.com/matklad/once_cell |
| `open` | 5.3.4 | MIT | https://github.com/Byron/open-rs |
| `option-ext` | 0.2.0 | MPL-2.0 | https://github.com/soc/option-ext.git |
| `ordered-stream` | 0.2.0 | Apache-2.0 OR MIT | https://github.com/danieldg/ordered-stream |
| `os_info` | 3.14.0 | MIT | https://github.com/stanislav-tkach/os_info |
| `pango-sys` | 0.18.0 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `pango` | 0.18.3 | MIT | https://github.com/gtk-rs/gtk-rs-core |
| `parking_lot_core` | 0.9.12 | Apache-2.0 OR MIT | https://github.com/Amanieu/parking_lot |
| `parking_lot` | 0.12.5 | Apache-2.0 OR MIT | https://github.com/Amanieu/parking_lot |
| `parking` | 2.2.1 | Apache-2.0 OR MIT | https://github.com/smol-rs/parking |
| `password-hash` | 0.4.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/traits/tree/master/password-hash |
| `pathdiff` | 0.2.3 | Apache-2.0 OR MIT | https://github.com/Manishearth/pathdiff |
| `pbkdf2` | 0.11.0 | Apache-2.0 OR MIT | https://github.com/RustCrypto/password-hashes/tree/master/pbkdf2 |
| `percent-encoding` | 2.3.2 | Apache-2.0 OR MIT | https://github.com/servo/rust-url/ |
| `phf_codegen` | 0.11.3 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_codegen` | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_codegen` | 0.8.0 | MIT | https://github.com/sfackler/rust-phf |
| `phf_generator` | 0.10.0 | MIT | https://github.com/sfackler/rust-phf |
| `phf_generator` | 0.11.3 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_generator` | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_generator` | 0.8.0 | MIT | https://github.com/sfackler/rust-phf |
| `phf_macros` | 0.10.0 | MIT | https://github.com/sfackler/rust-phf |
| `phf_macros` | 0.11.3 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_macros` | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_shared` | 0.10.0 | MIT | https://github.com/sfackler/rust-phf |
| `phf_shared` | 0.11.3 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_shared` | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| `phf_shared` | 0.8.0 | MIT | https://github.com/sfackler/rust-phf |
| `phf` | 0.10.1 | MIT | https://github.com/sfackler/rust-phf |
| `phf` | 0.11.3 | MIT | https://github.com/rust-phf/rust-phf |
| `phf` | 0.13.1 | MIT | https://github.com/rust-phf/rust-phf |
| `phf` | 0.8.0 | MIT | https://github.com/sfackler/rust-phf |
| `pin-project-lite` | 0.2.17 | Apache-2.0 OR MIT | https://github.com/taiki-e/pin-project-lite |
| `piper` | 0.2.5 | Apache-2.0 OR MIT | https://github.com/smol-rs/piper |
| `pkg-config` | 0.3.33 | Apache-2.0 OR MIT | https://github.com/rust-lang/pkg-config-rs |
| `plain` | 0.2.3 | Apache-2.0 OR MIT | https://github.com/randomites/plain |
| `plist` | 1.8.0 | MIT | https://github.com/ebarnard/rust-plist/ |
| `png` | 0.17.16 | Apache-2.0 OR MIT | https://github.com/image-rs/image-png |
| `polling` | 3.11.0 | Apache-2.0 OR MIT | https://github.com/smol-rs/polling |
| `potential_utf` | 0.1.5 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `powerfmt` | 0.2.0 | Apache-2.0 OR MIT | https://github.com/jhpratt/powerfmt |
| `ppv-lite86` | 0.2.21 | Apache-2.0 OR MIT | https://github.com/cryptocorrosion/cryptocorrosion |
| `precomputed-hash` | 0.1.1 | MIT | https://github.com/emilio/precomputed-hash |
| `prettyplease` | 0.2.37 | Apache-2.0 OR MIT | https://github.com/dtolnay/prettyplease |
| `proc-macro-crate` | 1.3.1 | Apache-2.0 OR MIT | https://github.com/bkchr/proc-macro-crate |
| `proc-macro-crate` | 2.0.2 | Apache-2.0 OR MIT | https://github.com/bkchr/proc-macro-crate |
| `proc-macro-crate` | 3.5.0 | Apache-2.0 OR MIT | https://github.com/bkchr/proc-macro-crate |
| `proc-macro-error-attr` | 1.0.4 | Apache-2.0 OR MIT | https://gitlab.com/CreepySkeleton/proc-macro-error |
| `proc-macro-error` | 1.0.4 | Apache-2.0 OR MIT | https://gitlab.com/CreepySkeleton/proc-macro-error |
| `proc-macro-hack` | 0.5.20+deprecated | Apache-2.0 OR MIT | https://github.com/dtolnay/proc-macro-hack |
| `proc-macro2` | 1.0.106 | Apache-2.0 OR MIT | https://github.com/dtolnay/proc-macro2 |
| `quick-xml` | 0.38.4 | MIT | https://github.com/tafia/quick-xml |
| `quinn-proto` | 0.11.14 | Apache-2.0 OR MIT | https://github.com/quinn-rs/quinn |
| `quinn-udp` | 0.5.14 | Apache-2.0 OR MIT | https://github.com/quinn-rs/quinn |
| `quinn` | 0.11.9 | Apache-2.0 OR MIT | https://github.com/quinn-rs/quinn |
| `quote` | 1.0.45 | Apache-2.0 OR MIT | https://github.com/dtolnay/quote |
| `r-efi` | 5.3.0 | Apache-2.0 OR LGPL-2.1-or-later OR MIT | https://github.com/r-efi/r-efi |
| `r-efi` | 6.0.0 | Apache-2.0 OR LGPL-2.1-or-later OR MIT | https://github.com/r-efi/r-efi |
| `rand_chacha` | 0.2.2 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| `rand_chacha` | 0.3.1 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| `rand_chacha` | 0.9.0 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| `rand_core` | 0.5.1 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| `rand_core` | 0.6.4 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| `rand_core` | 0.9.5 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| `rand_hc` | 0.2.0 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| `rand_pcg` | 0.2.1 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| `rand` | 0.7.3 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| `rand` | 0.8.6 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| `rand` | 0.9.4 | Apache-2.0 OR MIT | https://github.com/rust-random/rand |
| `raw-window-handle` | 0.6.2 | Apache-2.0 OR MIT OR Zlib | https://github.com/rust-windowing/raw-window-handle |
| `redox_syscall` | 0.5.18 | MIT | https://gitlab.redox-os.org/redox-os/syscall |
| `redox_syscall` | 0.7.4 | MIT | https://gitlab.redox-os.org/redox-os/syscall |
| `redox_users` | 0.4.6 | MIT | https://gitlab.redox-os.org/redox-os/users |
| `redox_users` | 0.5.2 | MIT | https://gitlab.redox-os.org/redox-os/users |
| `ref-cast-impl` | 1.0.25 | Apache-2.0 OR MIT | https://github.com/dtolnay/ref-cast |
| `ref-cast` | 1.0.25 | Apache-2.0 OR MIT | https://github.com/dtolnay/ref-cast |
| `regex-automata` | 0.4.14 | Apache-2.0 OR MIT | https://github.com/rust-lang/regex |
| `regex-syntax` | 0.8.10 | Apache-2.0 OR MIT | https://github.com/rust-lang/regex |
| `regex` | 1.12.3 | Apache-2.0 OR MIT | https://github.com/rust-lang/regex |
| `reqwest` | 0.12.28 | Apache-2.0 OR MIT | https://github.com/seanmonstar/reqwest |
| `reqwest` | 0.13.2 | Apache-2.0 OR MIT | https://github.com/seanmonstar/reqwest |
| `ring` | 0.17.14 | Apache-2.0 AND ISC | https://github.com/briansmith/ring |
| `rustc_version` | 0.4.1 | Apache-2.0 OR MIT | https://github.com/djc/rustc-version-rs |
| `rustc-hash` | 2.1.2 | Apache-2.0 OR MIT | https://github.com/rust-lang/rustc-hash |
| `rustix` | 0.38.44 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/rustix |
| `rustix` | 1.1.4 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/rustix |
| `rustls-pki-types` | 1.14.0 | Apache-2.0 OR MIT | https://github.com/rustls/pki-types |
| `rustls-webpki` | 0.103.13 | ISC | https://github.com/rustls/webpki |
| `rustls` | 0.23.39 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/rustls |
| `rustversion` | 1.0.22 | Apache-2.0 OR MIT | https://github.com/dtolnay/rustversion |
| `ruzstd` | 0.7.3 | MIT | https://github.com/KillingSpark/zstd-rs |
| `ryu` | 1.0.23 | Apache-2.0 OR BSL-1.0 | https://github.com/dtolnay/ryu |
| `same-file` | 1.0.6 | MIT OR Unlicense | https://github.com/BurntSushi/same-file |
| `schemars_derive` | 0.8.22 | MIT | https://github.com/GREsau/schemars |
| `schemars` | 0.8.22 | MIT | https://github.com/GREsau/schemars |
| `schemars` | 0.9.0 | MIT | https://github.com/GREsau/schemars |
| `schemars` | 1.2.1 | MIT | https://github.com/GREsau/schemars |
| `scopeguard` | 1.2.0 | Apache-2.0 OR MIT | https://github.com/bluss/scopeguard |
| `selectors` | 0.24.0 | MPL-2.0 | https://github.com/servo/servo |
| `selectors` | 0.36.1 | MPL-2.0 | https://github.com/servo/stylo |
| `semver` | 1.0.28 | Apache-2.0 OR MIT | https://github.com/dtolnay/semver |
| `serde_core` | 1.0.228 | Apache-2.0 OR MIT | https://github.com/serde-rs/serde |
| `serde_derive_internals` | 0.29.1 | Apache-2.0 OR MIT | https://github.com/serde-rs/serde |
| `serde_derive` | 1.0.228 | Apache-2.0 OR MIT | https://github.com/serde-rs/serde |
| `serde_json` | 1.0.149 | Apache-2.0 OR MIT | https://github.com/serde-rs/json |
| `serde_norway` | 0.9.42 | Apache-2.0 OR MIT | https://github.com/cafkafk/serde-yaml |
| `serde_repr` | 0.1.20 | Apache-2.0 OR MIT | https://github.com/dtolnay/serde-repr |
| `serde_spanned` | 0.6.9 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `serde_spanned` | 1.1.1 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `serde_urlencoded` | 0.7.1 | Apache-2.0 OR MIT | https://github.com/nox/serde_urlencoded |
| `serde_with_macros` | 3.18.0 | Apache-2.0 OR MIT | https://github.com/jonasbb/serde_with/ |
| `serde_with` | 3.18.0 | Apache-2.0 OR MIT | https://github.com/jonasbb/serde_with/ |
| `serde-untagged` | 0.1.9 | Apache-2.0 OR MIT | https://github.com/dtolnay/serde-untagged |
| `serde` | 1.0.228 | Apache-2.0 OR MIT | https://github.com/serde-rs/serde |
| `serialize-to-javascript-impl` | 0.1.2 | Apache-2.0 OR MIT | https://github.com/chippers/serialize-to-javascript |
| `serialize-to-javascript` | 0.1.2 | Apache-2.0 OR MIT | https://github.com/chippers/serialize-to-javascript |
| `servo_arc` | 0.2.0 | Apache-2.0 OR MIT | https://github.com/servo/servo |
| `servo_arc` | 0.4.3 | Apache-2.0 OR MIT | https://github.com/servo/stylo |
| `sha1` | 0.10.6 | Apache-2.0 OR MIT | https://github.com/RustCrypto/hashes |
| `sha2` | 0.10.9 | Apache-2.0 OR MIT | https://github.com/RustCrypto/hashes |
| `shlex` | 1.3.0 | Apache-2.0 OR MIT | https://github.com/comex/rust-shlex |
| `signal-hook-registry` | 1.4.8 | Apache-2.0 OR MIT | https://github.com/vorner/signal-hook |
| `simd-adler32` | 0.3.9 | MIT | https://github.com/mcountryman/simd-adler32 |
| `siphasher` | 0.3.11 | Apache-2.0 OR MIT | https://github.com/jedisct1/rust-siphash |
| `siphasher` | 1.0.2 | Apache-2.0 OR MIT | https://github.com/jedisct1/rust-siphash |
| `slab` | 0.4.12 | MIT | https://github.com/tokio-rs/slab |
| `smallvec` | 1.15.1 | Apache-2.0 OR MIT | https://github.com/servo/rust-smallvec |
| `socket2` | 0.6.3 | Apache-2.0 OR MIT | https://github.com/rust-lang/socket2 |
| `softbuffer` | 0.4.8 | Apache-2.0 OR MIT | https://github.com/rust-windowing/softbuffer |
| `soup3-sys` | 0.5.0 | MIT | https://gitlab.gnome.org/World/Rust/soup3-rs |
| `soup3` | 0.5.0 | MIT | https://gitlab.gnome.org/World/Rust/soup3-rs |
| `stable_deref_trait` | 1.2.1 | Apache-2.0 OR MIT | https://github.com/storyyeller/stable_deref_trait |
| `static_assertions` | 1.1.0 | Apache-2.0 OR MIT | https://github.com/nvzqz/static-assertions-rs |
| `string_cache_codegen` | 0.5.4 | Apache-2.0 OR MIT | https://github.com/servo/string-cache |
| `string_cache_codegen` | 0.6.1 | Apache-2.0 OR MIT | https://github.com/servo/string-cache |
| `string_cache` | 0.8.9 | Apache-2.0 OR MIT | https://github.com/servo/string-cache |
| `string_cache` | 0.9.0 | Apache-2.0 OR MIT | https://github.com/servo/string-cache |
| `strsim` | 0.11.1 | MIT | https://github.com/rapidfuzz/strsim-rs |
| `subtle` | 2.6.1 | BSD-3-Clause | https://github.com/dalek-cryptography/subtle |
| `swift-rs` | 1.0.7 | Apache-2.0 OR MIT | https://github.com/Brendonovich/swift-rs |
| `syn` | 1.0.109 | Apache-2.0 OR MIT | https://github.com/dtolnay/syn |
| `syn` | 2.0.117 | Apache-2.0 OR MIT | https://github.com/dtolnay/syn |
| `sync_wrapper` | 1.0.2 | Apache-2.0 | https://github.com/Actyx/sync_wrapper |
| `synstructure` | 0.13.2 | MIT | https://github.com/mystor/synstructure |
| `sys-locale` | 0.3.2 | Apache-2.0 OR MIT | https://github.com/1Password/sys-locale |
| `system-deps` | 6.2.2 | Apache-2.0 OR MIT | https://github.com/gdesmott/system-deps |
| `tao-macros` | 0.1.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tao |
| `tao` | 0.34.8 | Apache-2.0 | https://github.com/tauri-apps/tao |
| `tar` | 0.4.45 | Apache-2.0 OR MIT | https://github.com/alexcrichton/tar-rs |
| `target-lexicon` | 0.12.16 | Apache-2.0 WITH LLVM-exception | https://github.com/bytecodealliance/target-lexicon |
| `tauri-build` | 2.5.6 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-codegen` | 2.5.5 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-macros` | 2.5.5 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-plugin-opener` | 2.5.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-os` | 2.3.2 | Apache-2.0 OR MIT | https://github.com/tauri-apps/plugins-workspace |
| `tauri-plugin` | 2.5.4 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-runtime-wry` | 2.10.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-runtime` | 2.10.1 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-utils` | 2.8.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tauri-winres` | 0.3.5 | MIT | https://github.com/tauri-apps/winres |
| `tauri` | 2.10.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| `tempfile` | 3.27.0 | Apache-2.0 OR MIT | https://github.com/Stebalien/tempfile |
| `tendril` | 0.4.3 | Apache-2.0 OR MIT | https://github.com/servo/tendril |
| `tendril` | 0.5.0 | Apache-2.0 OR MIT | https://github.com/servo/html5ever |
| `thiserror-impl` | 1.0.69 | Apache-2.0 OR MIT | https://github.com/dtolnay/thiserror |
| `thiserror-impl` | 2.0.18 | Apache-2.0 OR MIT | https://github.com/dtolnay/thiserror |
| `thiserror` | 1.0.69 | Apache-2.0 OR MIT | https://github.com/dtolnay/thiserror |
| `thiserror` | 2.0.18 | Apache-2.0 OR MIT | https://github.com/dtolnay/thiserror |
| `time-core` | 0.1.8 | Apache-2.0 OR MIT | https://github.com/time-rs/time |
| `time-macros` | 0.2.27 | Apache-2.0 OR MIT | https://github.com/time-rs/time |
| `time` | 0.3.47 | Apache-2.0 OR MIT | https://github.com/time-rs/time |
| `tinystr` | 0.8.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `tinyvec_macros` | 0.1.1 | Apache-2.0 OR MIT OR Zlib | https://github.com/Soveu/tinyvec_macros |
| `tinyvec` | 1.11.0 | Apache-2.0 OR MIT OR Zlib | https://github.com/Lokathor/tinyvec |
| `tokio-macros` | 2.7.0 | MIT | https://github.com/tokio-rs/tokio |
| `tokio-rustls` | 0.26.4 | Apache-2.0 OR MIT | https://github.com/rustls/tokio-rustls |
| `tokio-util` | 0.7.18 | MIT | https://github.com/tokio-rs/tokio |
| `tokio` | 1.52.1 | MIT | https://github.com/tokio-rs/tokio |
| `toml_datetime` | 0.6.3 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `toml_datetime` | 0.7.5+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `toml_datetime` | 1.1.1+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `toml_edit` | 0.19.15 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `toml_edit` | 0.20.2 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `toml_edit` | 0.25.11+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `toml_parser` | 1.1.2+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `toml_writer` | 1.1.1+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `toml` | 0.8.2 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `toml` | 0.9.12+spec-1.1.0 | Apache-2.0 OR MIT | https://github.com/toml-rs/toml |
| `tower-http` | 0.6.8 | MIT | https://github.com/tower-rs/tower-http |
| `tower-layer` | 0.3.3 | MIT | https://github.com/tower-rs/tower |
| `tower-service` | 0.3.3 | MIT | https://github.com/tower-rs/tower |
| `tower` | 0.5.3 | MIT | https://github.com/tower-rs/tower |
| `tracing-attributes` | 0.1.31 | MIT | https://github.com/tokio-rs/tracing |
| `tracing-core` | 0.1.36 | MIT | https://github.com/tokio-rs/tracing |
| `tracing` | 0.1.44 | MIT | https://github.com/tokio-rs/tracing |
| `tray-icon` | 0.21.3 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tray-icon |
| `try-lock` | 0.2.5 | MIT | https://github.com/seanmonstar/try-lock |
| `twox-hash` | 1.6.3 | MIT | https://github.com/shepmaster/twox-hash |
| `typeid` | 1.0.3 | Apache-2.0 OR MIT | https://github.com/dtolnay/typeid |
| `typenum` | 1.20.0 | Apache-2.0 OR MIT | https://github.com/paholg/typenum |
| `uds_windows` | 1.2.1 | MIT | https://github.com/haraldh/rust_uds_windows |
| `unic-char-property` | 0.9.0 | Apache-2.0 OR MIT | https://github.com/open-i18n/rust-unic/ |
| `unic-char-range` | 0.9.0 | Apache-2.0 OR MIT | https://github.com/open-i18n/rust-unic/ |
| `unic-common` | 0.9.0 | Apache-2.0 OR MIT | https://github.com/open-i18n/rust-unic/ |
| `unic-ucd-ident` | 0.9.0 | Apache-2.0 OR MIT | https://github.com/open-i18n/rust-unic/ |
| `unic-ucd-version` | 0.9.0 | Apache-2.0 OR MIT | https://github.com/open-i18n/rust-unic/ |
| `unicode-ident` | 1.0.24 | (Apache-2.0 OR MIT) AND Unicode-3.0 | https://github.com/dtolnay/unicode-ident |
| `unicode-segmentation` | 1.13.2 | Apache-2.0 OR MIT | https://github.com/unicode-rs/unicode-segmentation |
| `unicode-xid` | 0.2.6 | Apache-2.0 OR MIT | https://github.com/unicode-rs/unicode-xid |
| `unsafe-libyaml-norway` | 0.2.15 | MIT | https://github.com/cafkafk/unsafe-libyaml-norway |
| `untrusted` | 0.9.0 | ISC | https://github.com/briansmith/untrusted |
| `url` | 2.5.8 | Apache-2.0 OR MIT | https://github.com/servo/rust-url |
| `urlpattern` | 0.3.0 | MIT | https://github.com/denoland/rust-urlpattern |
| `utf-8` | 0.7.6 | Apache-2.0 OR MIT | https://github.com/SimonSapin/rust-utf8 |
| `utf8_iter` | 1.0.4 | Apache-2.0 OR MIT | https://github.com/hsivonen/utf8_iter |
| `uuid` | 1.23.1 | Apache-2.0 OR MIT | https://github.com/uuid-rs/uuid |
| `version_check` | 0.9.5 | Apache-2.0 OR MIT | https://github.com/SergioBenitez/version_check |
| `version-compare` | 0.2.1 | MIT | https://gitlab.com/timvisee/version-compare |
| `vswhom-sys` | 0.1.3 | MIT | https://github.com/nabijaczleweli/vswhom-sys.rs |
| `vswhom` | 0.1.0 | MIT | https://github.com/nabijaczleweli/vswhom.rs |
| `walkdir` | 2.5.0 | MIT OR Unlicense | https://github.com/BurntSushi/walkdir |
| `want` | 0.3.1 | MIT | https://github.com/seanmonstar/want |
| `wasi` | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wasi |
| `wasi` | 0.9.0+wasi-snapshot-preview1 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wasi |
| `wasip2` | 1.0.3+wasi-0.2.9 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wasi-rs |
| `wasip3` | 0.4.0+wasi-0.3.0-rc-2026-01-06 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wasi-rs |
| `wasm-bindgen-futures` | 0.4.68 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures |
| `wasm-bindgen-macro-support` | 0.2.118 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro-support |
| `wasm-bindgen-macro` | 0.2.118 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro |
| `wasm-bindgen-shared` | 0.2.118 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared |
| `wasm-bindgen` | 0.2.118 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen |
| `wasm-encoder` | 0.244.0 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasm-encoder |
| `wasm-metadata` | 0.244.0 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasm-metadata |
| `wasm-streams` | 0.4.2 | Apache-2.0 OR MIT | https://github.com/MattiasBuelens/wasm-streams/ |
| `wasm-streams` | 0.5.0 | Apache-2.0 OR MIT | https://github.com/MattiasBuelens/wasm-streams/ |
| `wasmparser` | 0.244.0 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasmparser |
| `web_atoms` | 0.2.4 | Apache-2.0 OR MIT | https://github.com/servo/html5ever |
| `web-sys` | 0.3.95 | Apache-2.0 OR MIT | https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys |
| `web-time` | 1.1.0 | Apache-2.0 OR MIT | https://github.com/daxpedda/web-time |
| `webkit2gtk-sys` | 2.0.2 | MIT | https://github.com/tauri-apps/webkit2gtk-rs |
| `webkit2gtk` | 2.0.2 | MIT | https://github.com/tauri-apps/webkit2gtk-rs |
| `webpki-roots` | 1.0.7 | CDLA-Permissive-2.0 | https://github.com/rustls/webpki-roots |
| `webview2-com-macros` | 0.8.1 | MIT | https://github.com/wravery/webview2-rs |
| `webview2-com-sys` | 0.38.2 | MIT | https://github.com/wravery/webview2-rs |
| `webview2-com` | 0.38.2 | MIT | https://github.com/wravery/webview2-rs |
| `which` | 6.0.3 | MIT | https://github.com/harryfei/which-rs.git |
| `winapi-i686-pc-windows-gnu` | 0.4.0 | Apache-2.0 OR MIT | https://github.com/retep998/winapi-rs |
| `winapi-util` | 0.1.11 | MIT OR Unlicense | https://github.com/BurntSushi/winapi-util |
| `winapi-x86_64-pc-windows-gnu` | 0.4.0 | Apache-2.0 OR MIT | https://github.com/retep998/winapi-rs |
| `winapi` | 0.3.9 | Apache-2.0 OR MIT | https://github.com/retep998/winapi-rs |
| `window-vibrancy` | 0.6.0 | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri-plugin-vibrancy |
| `windows_aarch64_gnullvm` | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_aarch64_gnullvm` | 0.48.5 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_aarch64_gnullvm` | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_aarch64_gnullvm` | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_aarch64_msvc` | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_aarch64_msvc` | 0.48.5 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_aarch64_msvc` | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_aarch64_msvc` | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_i686_gnu` | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_i686_gnu` | 0.48.5 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_i686_gnu` | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_i686_gnu` | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_i686_gnullvm` | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_i686_gnullvm` | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_i686_msvc` | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_i686_msvc` | 0.48.5 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_i686_msvc` | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_i686_msvc` | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_gnu` | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_gnu` | 0.48.5 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_gnu` | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_gnu` | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_gnullvm` | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_gnullvm` | 0.48.5 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_gnullvm` | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_gnullvm` | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_msvc` | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_msvc` | 0.48.5 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_msvc` | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows_x86_64_msvc` | 0.53.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-collections` | 0.2.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-core` | 0.61.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-core` | 0.62.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-future` | 0.2.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-implement` | 0.60.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-interface` | 0.59.3 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-link` | 0.1.3 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-link` | 0.2.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-numerics` | 0.2.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-result` | 0.3.4 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-result` | 0.4.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-strings` | 0.4.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-strings` | 0.5.1 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-sys` | 0.45.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-sys` | 0.48.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-sys` | 0.52.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-sys` | 0.59.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-sys` | 0.60.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-sys` | 0.61.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-targets` | 0.42.2 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-targets` | 0.48.5 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-targets` | 0.52.6 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-targets` | 0.53.5 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-threading` | 0.1.0 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows-version` | 0.1.7 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `windows` | 0.61.3 | Apache-2.0 OR MIT | https://github.com/microsoft/windows-rs |
| `winnow` | 0.5.40 | MIT | https://github.com/winnow-rs/winnow |
| `winnow` | 0.7.15 | MIT | https://github.com/winnow-rs/winnow |
| `winnow` | 1.0.2 | MIT | https://github.com/winnow-rs/winnow |
| `winreg` | 0.55.0 | MIT | https://github.com/gentoo90/winreg-rs |
| `winsafe` | 0.0.19 | MIT | https://github.com/rodrigocfd/winsafe |
| `wit-bindgen-core` | 0.51.0 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| `wit-bindgen-rust-macro` | 0.51.0 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| `wit-bindgen-rust` | 0.51.0 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| `wit-bindgen` | 0.51.0 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| `wit-bindgen` | 0.57.1 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wit-bindgen |
| `wit-component` | 0.244.0 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wit-component |
| `wit-parser` | 0.244.0 | Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wit-parser |
| `writeable` | 0.6.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `wry` | 0.54.4 | Apache-2.0 OR MIT | https://github.com/tauri-apps/wry |
| `x11-dl` | 2.21.0 | MIT | https://github.com/AltF02/x11-rs.git |
| `x11` | 2.21.0 | MIT | https://github.com/AltF02/x11-rs.git |
| `xattr` | 1.6.1 | Apache-2.0 OR MIT | https://github.com/Stebalien/xattr |
| `yoke-derive` | 0.8.2 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `yoke` | 0.8.2 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zbus_macros` | 5.14.0 | MIT | https://github.com/z-galaxy/zbus/ |
| `zbus_names` | 4.3.1 | MIT | https://github.com/z-galaxy/zbus/ |
| `zbus` | 5.14.0 | MIT | https://github.com/z-galaxy/zbus/ |
| `zerocopy-derive` | 0.8.48 | Apache-2.0 OR BSD-2-Clause OR MIT | https://github.com/google/zerocopy |
| `zerocopy` | 0.8.48 | Apache-2.0 OR BSD-2-Clause OR MIT | https://github.com/google/zerocopy |
| `zerofrom-derive` | 0.1.7 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zerofrom` | 0.1.7 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zeroize` | 1.8.2 | Apache-2.0 OR MIT | https://github.com/RustCrypto/utils |
| `zerotrie` | 0.2.4 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zerovec-derive` | 0.11.3 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zerovec` | 0.11.6 | Unicode-3.0 | https://github.com/unicode-org/icu4x |
| `zip` | 0.6.6 | MIT | https://github.com/zip-rs/zip.git |
| `zmij` | 1.0.21 | MIT | https://github.com/dtolnay/zmij |
| `zstd-safe` | 5.0.2+zstd.1.5.2 | Apache-2.0 OR MIT | https://github.com/gyscos/zstd-rs |
| `zstd-sys` | 2.0.16+zstd.1.5.7 | Apache-2.0 OR MIT | https://github.com/gyscos/zstd-rs |
| `zstd` | 0.11.2+zstd.1.5.2 | MIT | https://github.com/gyscos/zstd-rs |
| `zvariant_derive` | 5.10.0 | MIT | https://github.com/z-galaxy/zbus/ |
| `zvariant_utils` | 3.3.0 | MIT | https://github.com/z-galaxy/zbus/ |
| `zvariant` | 5.10.0 | MIT | https://github.com/z-galaxy/zbus/ |

## npm / JSR packages

Bundled into: the Atlas daemon, CLI, web playground, and any compiled
Deno binaries. Inventory is taken from `deno.lock`.

| Package | Version | Source |
| --- | --- | --- |
| `@ai-sdk/anthropic` | 3.0.71 | https://www.npmjs.com/package/@ai-sdk/anthropic |
| `@ai-sdk/fireworks` | 2.0.46 | https://www.npmjs.com/package/@ai-sdk/fireworks |
| `@ai-sdk/gateway` | 3.0.104 | https://www.npmjs.com/package/@ai-sdk/gateway |
| `@ai-sdk/google` | 3.0.64 | https://www.npmjs.com/package/@ai-sdk/google |
| `@ai-sdk/groq` | 3.0.35 | https://www.npmjs.com/package/@ai-sdk/groq |
| `@ai-sdk/mcp` | 1.0.36 | https://www.npmjs.com/package/@ai-sdk/mcp |
| `@ai-sdk/openai-compatible` | 2.0.41 | https://www.npmjs.com/package/@ai-sdk/openai-compatible |
| `@ai-sdk/openai` | 3.0.53 | https://www.npmjs.com/package/@ai-sdk/openai |
| `@ai-sdk/provider-utils` | 4.0.23 | https://www.npmjs.com/package/@ai-sdk/provider-utils |
| `@ai-sdk/provider` | 3.0.8 | https://www.npmjs.com/package/@ai-sdk/provider |
| `@ai-sdk/svelte` | 4.0.168 | https://www.npmjs.com/package/@ai-sdk/svelte |
| `@alcalzone/ansi-tokenize` | 0.3.0 | https://www.npmjs.com/package/@alcalzone/ansi-tokenize |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64` | 0.2.121 | https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk-darwin-arm64 |
| `@anthropic-ai/claude-agent-sdk-darwin-x64` | 0.2.121 | https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk-darwin-x64 |
| `@anthropic-ai/claude-agent-sdk-linux-arm64-musl` | 0.2.121 | https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk-linux-arm64-musl |
| `@anthropic-ai/claude-agent-sdk-linux-arm64` | 0.2.121 | https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk-linux-arm64 |
| `@anthropic-ai/claude-agent-sdk-linux-x64-musl` | 0.2.121 | https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk-linux-x64-musl |
| `@anthropic-ai/claude-agent-sdk-linux-x64` | 0.2.121 | https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk-linux-x64 |
| `@anthropic-ai/claude-agent-sdk-win32-arm64` | 0.2.121 | https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk-win32-arm64 |
| `@anthropic-ai/claude-agent-sdk-win32-x64` | 0.2.121 | https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk-win32-x64 |
| `@anthropic-ai/claude-agent-sdk` | 0.2.121 | https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk |
| `@anthropic-ai/sdk` | 0.81.0 | https://www.npmjs.com/package/@anthropic-ai/sdk |
| `@azure/msal-common` | 15.17.0 | https://www.npmjs.com/package/@azure/msal-common |
| `@azure/msal-node` | 3.8.10 | https://www.npmjs.com/package/@azure/msal-node |
| `@babel/code-frame` | 7.29.0 | https://www.npmjs.com/package/@babel/code-frame |
| `@babel/generator` | 7.29.1 | https://www.npmjs.com/package/@babel/generator |
| `@babel/helper-globals` | 7.28.0 | https://www.npmjs.com/package/@babel/helper-globals |
| `@babel/helper-string-parser` | 7.27.1 | https://www.npmjs.com/package/@babel/helper-string-parser |
| `@babel/helper-validator-identifier` | 7.28.5 | https://www.npmjs.com/package/@babel/helper-validator-identifier |
| `@babel/parser` | 7.29.2 | https://www.npmjs.com/package/@babel/parser |
| `@babel/runtime` | 7.29.2 | https://www.npmjs.com/package/@babel/runtime |
| `@babel/template` | 7.28.6 | https://www.npmjs.com/package/@babel/template |
| `@babel/traverse` | 7.29.0 | https://www.npmjs.com/package/@babel/traverse |
| `@babel/types` | 7.29.0 | https://www.npmjs.com/package/@babel/types |
| `@bcoe/v8-coverage` | 1.0.2 | https://www.npmjs.com/package/@bcoe/v8-coverage |
| `@biomejs/biome` | 2.4.13 | https://www.npmjs.com/package/@biomejs/biome |
| `@biomejs/cli-darwin-arm64` | 2.4.13 | https://www.npmjs.com/package/@biomejs/cli-darwin-arm64 |
| `@biomejs/cli-darwin-x64` | 2.4.13 | https://www.npmjs.com/package/@biomejs/cli-darwin-x64 |
| `@biomejs/cli-linux-arm64-musl` | 2.4.13 | https://www.npmjs.com/package/@biomejs/cli-linux-arm64-musl |
| `@biomejs/cli-linux-arm64` | 2.4.13 | https://www.npmjs.com/package/@biomejs/cli-linux-arm64 |
| `@biomejs/cli-linux-x64-musl` | 2.4.13 | https://www.npmjs.com/package/@biomejs/cli-linux-x64-musl |
| `@biomejs/cli-linux-x64` | 2.4.13 | https://www.npmjs.com/package/@biomejs/cli-linux-x64 |
| `@biomejs/cli-win32-arm64` | 2.4.13 | https://www.npmjs.com/package/@biomejs/cli-win32-arm64 |
| `@biomejs/cli-win32-x64` | 2.4.13 | https://www.npmjs.com/package/@biomejs/cli-win32-x64 |
| `@borewit/text-codec` | 0.2.2 | https://www.npmjs.com/package/@borewit/text-codec |
| `@chat-adapter/discord` | 4.26.0 | https://www.npmjs.com/package/@chat-adapter/discord |
| `@chat-adapter/shared` | 4.26.0 | https://www.npmjs.com/package/@chat-adapter/shared |
| `@chat-adapter/slack` | 4.26.0 | https://www.npmjs.com/package/@chat-adapter/slack |
| `@chat-adapter/teams` | 4.26.0 | https://www.npmjs.com/package/@chat-adapter/teams |
| `@chat-adapter/telegram` | 4.26.0 | https://www.npmjs.com/package/@chat-adapter/telegram |
| `@chat-adapter/whatsapp` | 4.26.0 | https://www.npmjs.com/package/@chat-adapter/whatsapp |
| `@codemirror/autocomplete` | 6.20.1 | https://www.npmjs.com/package/@codemirror/autocomplete |
| `@codemirror/commands` | 6.10.3 | https://www.npmjs.com/package/@codemirror/commands |
| `@codemirror/lang-css` | 6.3.1 | https://www.npmjs.com/package/@codemirror/lang-css |
| `@codemirror/lang-html` | 6.4.11 | https://www.npmjs.com/package/@codemirror/lang-html |
| `@codemirror/lang-javascript` | 6.2.5 | https://www.npmjs.com/package/@codemirror/lang-javascript |
| `@codemirror/lang-markdown` | 6.5.0 | https://www.npmjs.com/package/@codemirror/lang-markdown |
| `@codemirror/lang-yaml` | 6.1.3 | https://www.npmjs.com/package/@codemirror/lang-yaml |
| `@codemirror/language` | 6.12.3 | https://www.npmjs.com/package/@codemirror/language |
| `@codemirror/lint` | 6.9.5 | https://www.npmjs.com/package/@codemirror/lint |
| `@codemirror/search` | 6.7.0 | https://www.npmjs.com/package/@codemirror/search |
| `@codemirror/state` | 6.6.0 | https://www.npmjs.com/package/@codemirror/state |
| `@codemirror/view` | 6.41.1 | https://www.npmjs.com/package/@codemirror/view |
| `@coderabbitai/bitbucket` | 1.1.4 | https://www.npmjs.com/package/@coderabbitai/bitbucket |
| `@deno/kv-darwin-arm64` | 0.13.0 | https://www.npmjs.com/package/@deno/kv-darwin-arm64 |
| `@deno/kv-darwin-x64` | 0.13.0 | https://www.npmjs.com/package/@deno/kv-darwin-x64 |
| `@deno/kv-linux-x64-gnu` | 0.13.0 | https://www.npmjs.com/package/@deno/kv-linux-x64-gnu |
| `@deno/kv-win32-x64-msvc` | 0.13.0 | https://www.npmjs.com/package/@deno/kv-win32-x64-msvc |
| `@deno/kv` | 0.13.0 | https://www.npmjs.com/package/@deno/kv |
| `@discordjs/builders` | 1.14.1 | https://www.npmjs.com/package/@discordjs/builders |
| `@discordjs/collection` | 1.5.3 | https://www.npmjs.com/package/@discordjs/collection |
| `@discordjs/collection` | 2.1.1 | https://www.npmjs.com/package/@discordjs/collection |
| `@discordjs/formatters` | 0.6.2 | https://www.npmjs.com/package/@discordjs/formatters |
| `@discordjs/rest` | 2.6.1 | https://www.npmjs.com/package/@discordjs/rest |
| `@discordjs/util` | 1.2.0 | https://www.npmjs.com/package/@discordjs/util |
| `@discordjs/ws` | 1.2.3 | https://www.npmjs.com/package/@discordjs/ws |
| `@emnapi/core` | 1.9.2 | https://www.npmjs.com/package/@emnapi/core |
| `@emnapi/runtime` | 1.9.2 | https://www.npmjs.com/package/@emnapi/runtime |
| `@emnapi/wasi-threads` | 1.2.1 | https://www.npmjs.com/package/@emnapi/wasi-threads |
| `@esbuild/aix-ppc64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/aix-ppc64 |
| `@esbuild/android-arm64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/android-arm64 |
| `@esbuild/android-arm` | 0.27.7 | https://www.npmjs.com/package/@esbuild/android-arm |
| `@esbuild/android-x64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/android-x64 |
| `@esbuild/darwin-arm64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/darwin-arm64 |
| `@esbuild/darwin-x64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/darwin-x64 |
| `@esbuild/freebsd-arm64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/freebsd-arm64 |
| `@esbuild/freebsd-x64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/freebsd-x64 |
| `@esbuild/linux-arm64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/linux-arm64 |
| `@esbuild/linux-arm` | 0.27.7 | https://www.npmjs.com/package/@esbuild/linux-arm |
| `@esbuild/linux-ia32` | 0.27.7 | https://www.npmjs.com/package/@esbuild/linux-ia32 |
| `@esbuild/linux-loong64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/linux-loong64 |
| `@esbuild/linux-mips64el` | 0.27.7 | https://www.npmjs.com/package/@esbuild/linux-mips64el |
| `@esbuild/linux-ppc64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/linux-ppc64 |
| `@esbuild/linux-riscv64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/linux-riscv64 |
| `@esbuild/linux-s390x` | 0.27.7 | https://www.npmjs.com/package/@esbuild/linux-s390x |
| `@esbuild/linux-x64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/linux-x64 |
| `@esbuild/netbsd-arm64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/netbsd-arm64 |
| `@esbuild/netbsd-x64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/netbsd-x64 |
| `@esbuild/openbsd-arm64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/openbsd-arm64 |
| `@esbuild/openbsd-x64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/openbsd-x64 |
| `@esbuild/openharmony-arm64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/openharmony-arm64 |
| `@esbuild/sunos-x64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/sunos-x64 |
| `@esbuild/win32-arm64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/win32-arm64 |
| `@esbuild/win32-ia32` | 0.27.7 | https://www.npmjs.com/package/@esbuild/win32-ia32 |
| `@esbuild/win32-x64` | 0.27.7 | https://www.npmjs.com/package/@esbuild/win32-x64 |
| `@eslint-community/eslint-utils` | 4.9.1 | https://www.npmjs.com/package/@eslint-community/eslint-utils |
| `@eslint-community/regexpp` | 4.12.2 | https://www.npmjs.com/package/@eslint-community/regexpp |
| `@eslint/compat` | 2.0.5 | https://www.npmjs.com/package/@eslint/compat |
| `@eslint/config-array` | 0.23.5 | https://www.npmjs.com/package/@eslint/config-array |
| `@eslint/config-helpers` | 0.5.5 | https://www.npmjs.com/package/@eslint/config-helpers |
| `@eslint/core` | 1.2.1 | https://www.npmjs.com/package/@eslint/core |
| `@eslint/js` | 10.0.1 | https://www.npmjs.com/package/@eslint/js |
| `@eslint/object-schema` | 3.0.5 | https://www.npmjs.com/package/@eslint/object-schema |
| `@eslint/plugin-kit` | 0.7.1 | https://www.npmjs.com/package/@eslint/plugin-kit |
| `@faker-js/faker` | 10.4.0 | https://www.npmjs.com/package/@faker-js/faker |
| `@floating-ui/core` | 1.7.5 | https://www.npmjs.com/package/@floating-ui/core |
| `@floating-ui/dom` | 1.7.6 | https://www.npmjs.com/package/@floating-ui/dom |
| `@floating-ui/utils` | 0.2.11 | https://www.npmjs.com/package/@floating-ui/utils |
| `@hono/mcp` | 0.2.5 | https://www.npmjs.com/package/@hono/mcp |
| `@hono/node-server` | 1.19.14 | https://www.npmjs.com/package/@hono/node-server |
| `@hono/standard-validator` | 0.2.2 | https://www.npmjs.com/package/@hono/standard-validator |
| `@hono/zod-validator` | 0.7.6 | https://www.npmjs.com/package/@hono/zod-validator |
| `@hubspot/api-client` | 13.5.0 | https://www.npmjs.com/package/@hubspot/api-client |
| `@humanfs/core` | 0.19.2 | https://www.npmjs.com/package/@humanfs/core |
| `@humanfs/node` | 0.16.8 | https://www.npmjs.com/package/@humanfs/node |
| `@humanfs/types` | 0.15.0 | https://www.npmjs.com/package/@humanfs/types |
| `@humanwhocodes/module-importer` | 1.0.1 | https://www.npmjs.com/package/@humanwhocodes/module-importer |
| `@humanwhocodes/retry` | 0.4.3 | https://www.npmjs.com/package/@humanwhocodes/retry |
| `@ianvs/prettier-plugin-sort-imports` | 4.7.1 | https://www.npmjs.com/package/@ianvs/prettier-plugin-sort-imports |
| `@inkjs/ui` | 2.0.0 | https://www.npmjs.com/package/@inkjs/ui |
| `@internationalized/date` | 3.12.1 | https://www.npmjs.com/package/@internationalized/date |
| `@isaacs/fs-minipass` | 4.0.1 | https://www.npmjs.com/package/@isaacs/fs-minipass |
| `@jridgewell/gen-mapping` | 0.3.13 | https://www.npmjs.com/package/@jridgewell/gen-mapping |
| `@jridgewell/remapping` | 2.3.5 | https://www.npmjs.com/package/@jridgewell/remapping |
| `@jridgewell/resolve-uri` | 3.1.2 | https://www.npmjs.com/package/@jridgewell/resolve-uri |
| `@jridgewell/sourcemap-codec` | 1.5.5 | https://www.npmjs.com/package/@jridgewell/sourcemap-codec |
| `@jridgewell/trace-mapping` | 0.3.31 | https://www.npmjs.com/package/@jridgewell/trace-mapping |
| `@jsr/db__sqlite` | 0.12.0 | https://www.npmjs.com/package/@jsr/db__sqlite |
| `@jsr/denosaurs__plug` | 1.1.0 | https://www.npmjs.com/package/@jsr/denosaurs__plug |
| `@jsr/std__assert` | 0.217.0 | https://www.npmjs.com/package/@jsr/std__assert |
| `@jsr/std__assert` | 1.0.19 | https://www.npmjs.com/package/@jsr/std__assert |
| `@jsr/std__async` | 1.0.15 | https://www.npmjs.com/package/@jsr/std__async |
| `@jsr/std__collections` | 1.1.7 | https://www.npmjs.com/package/@jsr/std__collections |
| `@jsr/std__dotenv` | 0.225.6 | https://www.npmjs.com/package/@jsr/std__dotenv |
| `@jsr/std__encoding` | 1.0.10 | https://www.npmjs.com/package/@jsr/std__encoding |
| `@jsr/std__fmt` | 0.217.0 | https://www.npmjs.com/package/@jsr/std__fmt |
| `@jsr/std__fmt` | 1.0.10 | https://www.npmjs.com/package/@jsr/std__fmt |
| `@jsr/std__fs` | 1.0.23 | https://www.npmjs.com/package/@jsr/std__fs |
| `@jsr/std__internal` | 1.0.13 | https://www.npmjs.com/package/@jsr/std__internal |
| `@jsr/std__media-types` | 1.1.0 | https://www.npmjs.com/package/@jsr/std__media-types |
| `@jsr/std__path` | 0.217.0 | https://www.npmjs.com/package/@jsr/std__path |
| `@jsr/std__path` | 1.1.4 | https://www.npmjs.com/package/@jsr/std__path |
| `@jsr/std__yaml` | 1.1.0 | https://www.npmjs.com/package/@jsr/std__yaml |
| `@lezer/common` | 1.5.2 | https://www.npmjs.com/package/@lezer/common |
| `@lezer/css` | 1.3.3 | https://www.npmjs.com/package/@lezer/css |
| `@lezer/highlight` | 1.2.3 | https://www.npmjs.com/package/@lezer/highlight |
| `@lezer/html` | 1.3.13 | https://www.npmjs.com/package/@lezer/html |
| `@lezer/javascript` | 1.5.4 | https://www.npmjs.com/package/@lezer/javascript |
| `@lezer/lr` | 1.4.10 | https://www.npmjs.com/package/@lezer/lr |
| `@lezer/markdown` | 1.6.3 | https://www.npmjs.com/package/@lezer/markdown |
| `@lezer/yaml` | 1.0.4 | https://www.npmjs.com/package/@lezer/yaml |
| `@libpdf/core` | 0.3.4 | https://www.npmjs.com/package/@libpdf/core |
| `@marijn/find-cluster-break` | 1.0.2 | https://www.npmjs.com/package/@marijn/find-cluster-break |
| `@melt-ui/svelte` | 0.86.6 | https://www.npmjs.com/package/@melt-ui/svelte |
| `@microsoft/teams.api` | 2.0.8 | https://www.npmjs.com/package/@microsoft/teams.api |
| `@microsoft/teams.apps` | 2.0.8 | https://www.npmjs.com/package/@microsoft/teams.apps |
| `@microsoft/teams.cards` | 2.0.8 | https://www.npmjs.com/package/@microsoft/teams.cards |
| `@microsoft/teams.common` | 2.0.8 | https://www.npmjs.com/package/@microsoft/teams.common |
| `@microsoft/teams.graph-endpoints` | 2.0.8 | https://www.npmjs.com/package/@microsoft/teams.graph-endpoints |
| `@microsoft/teams.graph` | 2.0.8 | https://www.npmjs.com/package/@microsoft/teams.graph |
| `@mixmark-io/domino` | 2.2.0 | https://www.npmjs.com/package/@mixmark-io/domino |
| `@modelcontextprotocol/sdk` | 1.28.0 | https://www.npmjs.com/package/@modelcontextprotocol/sdk |
| `@modelcontextprotocol/sdk` | 1.29.0 | https://www.npmjs.com/package/@modelcontextprotocol/sdk |
| `@napi-rs/wasm-runtime` | 1.1.4 | https://www.npmjs.com/package/@napi-rs/wasm-runtime |
| `@noble/ciphers` | 2.2.0 | https://www.npmjs.com/package/@noble/ciphers |
| `@noble/hashes` | 1.4.0 | https://www.npmjs.com/package/@noble/hashes |
| `@noble/hashes` | 2.2.0 | https://www.npmjs.com/package/@noble/hashes |
| `@nodelib/fs.scandir` | 2.1.5 | https://www.npmjs.com/package/@nodelib/fs.scandir |
| `@nodelib/fs.stat` | 2.0.5 | https://www.npmjs.com/package/@nodelib/fs.stat |
| `@nodelib/fs.walk` | 1.2.8 | https://www.npmjs.com/package/@nodelib/fs.walk |
| `@opentelemetry/api-logs` | 0.215.0 | https://www.npmjs.com/package/@opentelemetry/api-logs |
| `@opentelemetry/api` | 1.9.0 | https://www.npmjs.com/package/@opentelemetry/api |
| `@opentelemetry/api` | 1.9.1 | https://www.npmjs.com/package/@opentelemetry/api |
| `@opentelemetry/core` | 2.7.0 | https://www.npmjs.com/package/@opentelemetry/core |
| `@opentelemetry/exporter-logs-otlp-http` | 0.215.0 | https://www.npmjs.com/package/@opentelemetry/exporter-logs-otlp-http |
| `@opentelemetry/otlp-exporter-base` | 0.215.0 | https://www.npmjs.com/package/@opentelemetry/otlp-exporter-base |
| `@opentelemetry/otlp-transformer` | 0.215.0 | https://www.npmjs.com/package/@opentelemetry/otlp-transformer |
| `@opentelemetry/resources` | 2.7.0 | https://www.npmjs.com/package/@opentelemetry/resources |
| `@opentelemetry/sdk-logs` | 0.215.0 | https://www.npmjs.com/package/@opentelemetry/sdk-logs |
| `@opentelemetry/sdk-metrics` | 2.7.0 | https://www.npmjs.com/package/@opentelemetry/sdk-metrics |
| `@opentelemetry/sdk-trace-base` | 2.7.0 | https://www.npmjs.com/package/@opentelemetry/sdk-trace-base |
| `@opentelemetry/semantic-conventions` | 1.40.0 | https://www.npmjs.com/package/@opentelemetry/semantic-conventions |
| `@oxc-parser/binding-android-arm-eabi` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-android-arm-eabi |
| `@oxc-parser/binding-android-arm64` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-android-arm64 |
| `@oxc-parser/binding-darwin-arm64` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-darwin-arm64 |
| `@oxc-parser/binding-darwin-x64` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-darwin-x64 |
| `@oxc-parser/binding-freebsd-x64` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-freebsd-x64 |
| `@oxc-parser/binding-linux-arm-gnueabihf` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-linux-arm-gnueabihf |
| `@oxc-parser/binding-linux-arm-musleabihf` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-linux-arm-musleabihf |
| `@oxc-parser/binding-linux-arm64-gnu` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-linux-arm64-gnu |
| `@oxc-parser/binding-linux-arm64-musl` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-linux-arm64-musl |
| `@oxc-parser/binding-linux-ppc64-gnu` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-linux-ppc64-gnu |
| `@oxc-parser/binding-linux-riscv64-gnu` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-linux-riscv64-gnu |
| `@oxc-parser/binding-linux-riscv64-musl` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-linux-riscv64-musl |
| `@oxc-parser/binding-linux-s390x-gnu` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-linux-s390x-gnu |
| `@oxc-parser/binding-linux-x64-gnu` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-linux-x64-gnu |
| `@oxc-parser/binding-linux-x64-musl` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-linux-x64-musl |
| `@oxc-parser/binding-openharmony-arm64` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-openharmony-arm64 |
| `@oxc-parser/binding-wasm32-wasi` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-wasm32-wasi |
| `@oxc-parser/binding-win32-arm64-msvc` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-win32-arm64-msvc |
| `@oxc-parser/binding-win32-ia32-msvc` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-win32-ia32-msvc |
| `@oxc-parser/binding-win32-x64-msvc` | 0.127.0 | https://www.npmjs.com/package/@oxc-parser/binding-win32-x64-msvc |
| `@oxc-project/types` | 0.127.0 | https://www.npmjs.com/package/@oxc-project/types |
| `@oxc-resolver/binding-android-arm-eabi` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-android-arm-eabi |
| `@oxc-resolver/binding-android-arm64` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-android-arm64 |
| `@oxc-resolver/binding-darwin-arm64` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-darwin-arm64 |
| `@oxc-resolver/binding-darwin-x64` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-darwin-x64 |
| `@oxc-resolver/binding-freebsd-x64` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-freebsd-x64 |
| `@oxc-resolver/binding-linux-arm-gnueabihf` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-linux-arm-gnueabihf |
| `@oxc-resolver/binding-linux-arm-musleabihf` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-linux-arm-musleabihf |
| `@oxc-resolver/binding-linux-arm64-gnu` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-linux-arm64-gnu |
| `@oxc-resolver/binding-linux-arm64-musl` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-linux-arm64-musl |
| `@oxc-resolver/binding-linux-ppc64-gnu` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-linux-ppc64-gnu |
| `@oxc-resolver/binding-linux-riscv64-gnu` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-linux-riscv64-gnu |
| `@oxc-resolver/binding-linux-riscv64-musl` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-linux-riscv64-musl |
| `@oxc-resolver/binding-linux-s390x-gnu` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-linux-s390x-gnu |
| `@oxc-resolver/binding-linux-x64-gnu` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-linux-x64-gnu |
| `@oxc-resolver/binding-linux-x64-musl` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-linux-x64-musl |
| `@oxc-resolver/binding-openharmony-arm64` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-openharmony-arm64 |
| `@oxc-resolver/binding-wasm32-wasi` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-wasm32-wasi |
| `@oxc-resolver/binding-win32-arm64-msvc` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-win32-arm64-msvc |
| `@oxc-resolver/binding-win32-ia32-msvc` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-win32-ia32-msvc |
| `@oxc-resolver/binding-win32-x64-msvc` | 11.19.1 | https://www.npmjs.com/package/@oxc-resolver/binding-win32-x64-msvc |
| `@polka/url` | 1.0.0-next.29 | https://www.npmjs.com/package/@polka/url |
| `@publint/pack` | 0.1.4 | https://www.npmjs.com/package/@publint/pack |
| `@redocly/ajv` | 8.11.2 | https://www.npmjs.com/package/@redocly/ajv |
| `@redocly/config` | 0.22.0 | https://www.npmjs.com/package/@redocly/config |
| `@redocly/openapi-core` | 1.34.13 | https://www.npmjs.com/package/@redocly/openapi-core |
| `@rollup/rollup-android-arm-eabi` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-android-arm-eabi |
| `@rollup/rollup-android-arm64` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-android-arm64 |
| `@rollup/rollup-darwin-arm64` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-darwin-arm64 |
| `@rollup/rollup-darwin-x64` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-darwin-x64 |
| `@rollup/rollup-freebsd-arm64` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-freebsd-arm64 |
| `@rollup/rollup-freebsd-x64` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-freebsd-x64 |
| `@rollup/rollup-linux-arm-gnueabihf` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-arm-gnueabihf |
| `@rollup/rollup-linux-arm-musleabihf` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-arm-musleabihf |
| `@rollup/rollup-linux-arm64-gnu` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-arm64-gnu |
| `@rollup/rollup-linux-arm64-musl` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-arm64-musl |
| `@rollup/rollup-linux-loong64-gnu` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-loong64-gnu |
| `@rollup/rollup-linux-loong64-musl` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-loong64-musl |
| `@rollup/rollup-linux-ppc64-gnu` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-ppc64-gnu |
| `@rollup/rollup-linux-ppc64-musl` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-ppc64-musl |
| `@rollup/rollup-linux-riscv64-gnu` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-riscv64-gnu |
| `@rollup/rollup-linux-riscv64-musl` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-riscv64-musl |
| `@rollup/rollup-linux-s390x-gnu` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-s390x-gnu |
| `@rollup/rollup-linux-x64-gnu` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-x64-gnu |
| `@rollup/rollup-linux-x64-musl` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-linux-x64-musl |
| `@rollup/rollup-openbsd-x64` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-openbsd-x64 |
| `@rollup/rollup-openharmony-arm64` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-openharmony-arm64 |
| `@rollup/rollup-win32-arm64-msvc` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-win32-arm64-msvc |
| `@rollup/rollup-win32-ia32-msvc` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-win32-ia32-msvc |
| `@rollup/rollup-win32-x64-gnu` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-win32-x64-gnu |
| `@rollup/rollup-win32-x64-msvc` | 4.60.2 | https://www.npmjs.com/package/@rollup/rollup-win32-x64-msvc |
| `@sapphire/async-queue` | 1.5.5 | https://www.npmjs.com/package/@sapphire/async-queue |
| `@sapphire/shapeshift` | 4.0.0 | https://www.npmjs.com/package/@sapphire/shapeshift |
| `@sapphire/snowflake` | 3.5.3 | https://www.npmjs.com/package/@sapphire/snowflake |
| `@sapphire/snowflake` | 3.5.5 | https://www.npmjs.com/package/@sapphire/snowflake |
| `@scure/base` | 2.2.0 | https://www.npmjs.com/package/@scure/base |
| `@sendgrid/helpers` | 8.0.0 | https://www.npmjs.com/package/@sendgrid/helpers |
| `@shikijs/core` | 4.0.2 | https://www.npmjs.com/package/@shikijs/core |
| `@shikijs/engine-javascript` | 4.0.2 | https://www.npmjs.com/package/@shikijs/engine-javascript |
| `@shikijs/engine-oniguruma` | 4.0.2 | https://www.npmjs.com/package/@shikijs/engine-oniguruma |
| `@shikijs/langs` | 4.0.2 | https://www.npmjs.com/package/@shikijs/langs |
| `@shikijs/primitive` | 4.0.2 | https://www.npmjs.com/package/@shikijs/primitive |
| `@shikijs/themes` | 4.0.2 | https://www.npmjs.com/package/@shikijs/themes |
| `@shikijs/types` | 4.0.2 | https://www.npmjs.com/package/@shikijs/types |
| `@shikijs/vscode-textmate` | 10.0.2 | https://www.npmjs.com/package/@shikijs/vscode-textmate |
| `@slack/logger` | 4.0.1 | https://www.npmjs.com/package/@slack/logger |
| `@slack/types` | 2.20.1 | https://www.npmjs.com/package/@slack/types |
| `@slack/web-api` | 7.15.1 | https://www.npmjs.com/package/@slack/web-api |
| `@standard-community/standard-json` | 0.3.5 | https://www.npmjs.com/package/@standard-community/standard-json |
| `@standard-community/standard-openapi` | 0.2.9 | https://www.npmjs.com/package/@standard-community/standard-openapi |
| `@standard-schema/spec` | 1.1.0 | https://www.npmjs.com/package/@standard-schema/spec |
| `@stardazed/streams-compression` | 1.0.0 | https://www.npmjs.com/package/@stardazed/streams-compression |
| `@stardazed/zlib` | 1.0.1 | https://www.npmjs.com/package/@stardazed/zlib |
| `@sveltejs/acorn-typescript` | 1.0.9 | https://www.npmjs.com/package/@sveltejs/acorn-typescript |
| `@sveltejs/adapter-auto` | 7.0.1 | https://www.npmjs.com/package/@sveltejs/adapter-auto |
| `@sveltejs/adapter-static` | 3.0.10 | https://www.npmjs.com/package/@sveltejs/adapter-static |
| `@sveltejs/kit` | 2.58.0 | https://www.npmjs.com/package/@sveltejs/kit |
| `@sveltejs/package` | 2.5.7 | https://www.npmjs.com/package/@sveltejs/package |
| `@sveltejs/vite-plugin-svelte-inspector` | 5.0.2 | https://www.npmjs.com/package/@sveltejs/vite-plugin-svelte-inspector |
| `@sveltejs/vite-plugin-svelte` | 6.2.4 | https://www.npmjs.com/package/@sveltejs/vite-plugin-svelte |
| `@swc/helpers` | 0.5.21 | https://www.npmjs.com/package/@swc/helpers |
| `@tanstack/query-core` | 5.100.5 | https://www.npmjs.com/package/@tanstack/query-core |
| `@tanstack/store` | 0.11.0 | https://www.npmjs.com/package/@tanstack/store |
| `@tanstack/svelte-query` | 6.1.24 | https://www.npmjs.com/package/@tanstack/svelte-query |
| `@tanstack/svelte-store` | 0.12.0 | https://www.npmjs.com/package/@tanstack/svelte-store |
| `@tanstack/svelte-table` | 9.0.0-alpha.37 | https://www.npmjs.com/package/@tanstack/svelte-table |
| `@tanstack/table-core` | 9.0.0-alpha.37 | https://www.npmjs.com/package/@tanstack/table-core |
| `@tauri-apps/api` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/api |
| `@tauri-apps/cli-darwin-arm64` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli-darwin-arm64 |
| `@tauri-apps/cli-darwin-x64` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli-darwin-x64 |
| `@tauri-apps/cli-linux-arm-gnueabihf` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli-linux-arm-gnueabihf |
| `@tauri-apps/cli-linux-arm64-gnu` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli-linux-arm64-gnu |
| `@tauri-apps/cli-linux-arm64-musl` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli-linux-arm64-musl |
| `@tauri-apps/cli-linux-riscv64-gnu` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli-linux-riscv64-gnu |
| `@tauri-apps/cli-linux-x64-gnu` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli-linux-x64-gnu |
| `@tauri-apps/cli-linux-x64-musl` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli-linux-x64-musl |
| `@tauri-apps/cli-win32-arm64-msvc` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli-win32-arm64-msvc |
| `@tauri-apps/cli-win32-ia32-msvc` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli-win32-ia32-msvc |
| `@tauri-apps/cli-win32-x64-msvc` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli-win32-x64-msvc |
| `@tauri-apps/cli` | 2.10.1 | https://www.npmjs.com/package/@tauri-apps/cli |
| `@tauri-apps/plugin-opener` | 2.5.3 | https://www.npmjs.com/package/@tauri-apps/plugin-opener |
| `@tokenizer/inflate` | 0.4.1 | https://www.npmjs.com/package/@tokenizer/inflate |
| `@tokenizer/token` | 0.3.0 | https://www.npmjs.com/package/@tokenizer/token |
| `@total-typescript/ts-reset` | 0.6.1 | https://www.npmjs.com/package/@total-typescript/ts-reset |
| `@tybys/wasm-util` | 0.10.1 | https://www.npmjs.com/package/@tybys/wasm-util |
| `@types/chai` | 5.2.3 | https://www.npmjs.com/package/@types/chai |
| `@types/cookie` | 0.6.0 | https://www.npmjs.com/package/@types/cookie |
| `@types/debug` | 4.1.13 | https://www.npmjs.com/package/@types/debug |
| `@types/deep-eql` | 4.0.2 | https://www.npmjs.com/package/@types/deep-eql |
| `@types/deno` | 2.5.0 | https://www.npmjs.com/package/@types/deno |
| `@types/esrecurse` | 4.3.1 | https://www.npmjs.com/package/@types/esrecurse |
| `@types/estree` | 1.0.8 | https://www.npmjs.com/package/@types/estree |
| `@types/hast` | 3.0.4 | https://www.npmjs.com/package/@types/hast |
| `@types/json-schema` | 7.0.15 | https://www.npmjs.com/package/@types/json-schema |
| `@types/jsonwebtoken` | 9.0.10 | https://www.npmjs.com/package/@types/jsonwebtoken |
| `@types/linkify-it` | 5.0.0 | https://www.npmjs.com/package/@types/linkify-it |
| `@types/markdown-it` | 14.1.2 | https://www.npmjs.com/package/@types/markdown-it |
| `@types/mdast` | 4.0.4 | https://www.npmjs.com/package/@types/mdast |
| `@types/mdurl` | 2.0.0 | https://www.npmjs.com/package/@types/mdurl |
| `@types/ms` | 2.1.0 | https://www.npmjs.com/package/@types/ms |
| `@types/node-fetch` | 2.6.13 | https://www.npmjs.com/package/@types/node-fetch |
| `@types/node` | 25.6.0 | https://www.npmjs.com/package/@types/node |
| `@types/papaparse` | 5.5.2 | https://www.npmjs.com/package/@types/papaparse |
| `@types/proper-lockfile` | 4.1.4 | https://www.npmjs.com/package/@types/proper-lockfile |
| `@types/react` | 19.2.14 | https://www.npmjs.com/package/@types/react |
| `@types/retry` | 0.12.0 | https://www.npmjs.com/package/@types/retry |
| `@types/trusted-types` | 2.0.7 | https://www.npmjs.com/package/@types/trusted-types |
| `@types/turndown` | 5.0.6 | https://www.npmjs.com/package/@types/turndown |
| `@types/unist` | 3.0.3 | https://www.npmjs.com/package/@types/unist |
| `@types/whatwg-mimetype` | 3.0.2 | https://www.npmjs.com/package/@types/whatwg-mimetype |
| `@types/ws` | 8.18.1 | https://www.npmjs.com/package/@types/ws |
| `@typescript-eslint/eslint-plugin` | 8.59.1 | https://www.npmjs.com/package/@typescript-eslint/eslint-plugin |
| `@typescript-eslint/parser` | 8.59.1 | https://www.npmjs.com/package/@typescript-eslint/parser |
| `@typescript-eslint/project-service` | 8.59.1 | https://www.npmjs.com/package/@typescript-eslint/project-service |
| `@typescript-eslint/scope-manager` | 8.59.1 | https://www.npmjs.com/package/@typescript-eslint/scope-manager |
| `@typescript-eslint/tsconfig-utils` | 8.59.1 | https://www.npmjs.com/package/@typescript-eslint/tsconfig-utils |
| `@typescript-eslint/type-utils` | 8.59.1 | https://www.npmjs.com/package/@typescript-eslint/type-utils |
| `@typescript-eslint/types` | 8.59.1 | https://www.npmjs.com/package/@typescript-eslint/types |
| `@typescript-eslint/typescript-estree` | 8.59.1 | https://www.npmjs.com/package/@typescript-eslint/typescript-estree |
| `@typescript-eslint/utils` | 8.59.1 | https://www.npmjs.com/package/@typescript-eslint/utils |
| `@typescript-eslint/visitor-keys` | 8.59.1 | https://www.npmjs.com/package/@typescript-eslint/visitor-keys |
| `@ungap/structured-clone` | 1.3.0 | https://www.npmjs.com/package/@ungap/structured-clone |
| `@vercel/oidc` | 3.2.0 | https://www.npmjs.com/package/@vercel/oidc |
| `@vitest/coverage-v8` | 4.1.5 | https://www.npmjs.com/package/@vitest/coverage-v8 |
| `@vitest/expect` | 4.1.5 | https://www.npmjs.com/package/@vitest/expect |
| `@vitest/mocker` | 4.1.5 | https://www.npmjs.com/package/@vitest/mocker |
| `@vitest/pretty-format` | 4.1.5 | https://www.npmjs.com/package/@vitest/pretty-format |
| `@vitest/runner` | 4.1.5 | https://www.npmjs.com/package/@vitest/runner |
| `@vitest/snapshot` | 4.1.5 | https://www.npmjs.com/package/@vitest/snapshot |
| `@vitest/spy` | 4.1.5 | https://www.npmjs.com/package/@vitest/spy |
| `@vitest/utils` | 4.1.5 | https://www.npmjs.com/package/@vitest/utils |
| `@vladfrangu/async_event_emitter` | 2.4.7 | https://www.npmjs.com/package/@vladfrangu/async_event_emitter |
| `@worker-tools/html-rewriter` | 0.1.0-pre.19 | https://www.npmjs.com/package/@worker-tools/html-rewriter |
| `@worker-tools/resolvable-promise` | 0.2.0-pre.6 | https://www.npmjs.com/package/@worker-tools/resolvable-promise |
| `@workflow/serde` | 4.1.0-beta.2 | https://www.npmjs.com/package/@workflow/serde |
| `@xmldom/xmldom` | 0.9.10 | https://www.npmjs.com/package/@xmldom/xmldom |
| `accepts` | 2.0.0 | https://www.npmjs.com/package/accepts |
| `acorn-jsx` | 5.3.2 | https://www.npmjs.com/package/acorn-jsx |
| `acorn` | 8.16.0 | https://www.npmjs.com/package/acorn |
| `agent-base` | 7.1.4 | https://www.npmjs.com/package/agent-base |
| `ai-sdk-provider-claude-code` | 3.4.4 | https://www.npmjs.com/package/ai-sdk-provider-claude-code |
| `ai` | 6.0.168 | https://www.npmjs.com/package/ai |
| `ajv-formats` | 3.0.1 | https://www.npmjs.com/package/ajv-formats |
| `ajv` | 6.15.0 | https://www.npmjs.com/package/ajv |
| `ajv` | 8.20.0 | https://www.npmjs.com/package/ajv |
| `ansi-colors` | 4.1.3 | https://www.npmjs.com/package/ansi-colors |
| `ansi-escapes` | 7.3.0 | https://www.npmjs.com/package/ansi-escapes |
| `ansi-regex` | 5.0.1 | https://www.npmjs.com/package/ansi-regex |
| `ansi-regex` | 6.2.2 | https://www.npmjs.com/package/ansi-regex |
| `ansi-styles` | 4.3.0 | https://www.npmjs.com/package/ansi-styles |
| `ansi-styles` | 6.2.3 | https://www.npmjs.com/package/ansi-styles |
| `argparse` | 2.0.1 | https://www.npmjs.com/package/argparse |
| `aria-query` | 5.3.1 | https://www.npmjs.com/package/aria-query |
| `asn1js` | 3.0.10 | https://www.npmjs.com/package/asn1js |
| `assertion-error` | 2.0.1 | https://www.npmjs.com/package/assertion-error |
| `ast-v8-to-istanbul` | 1.0.0 | https://www.npmjs.com/package/ast-v8-to-istanbul |
| `asynckit` | 0.4.0 | https://www.npmjs.com/package/asynckit |
| `auto-bind` | 5.0.1 | https://www.npmjs.com/package/auto-bind |
| `axios` | 1.15.2 | https://www.npmjs.com/package/axios |
| `axobject-query` | 4.1.0 | https://www.npmjs.com/package/axobject-query |
| `bail` | 2.0.2 | https://www.npmjs.com/package/bail |
| `balanced-match` | 1.0.2 | https://www.npmjs.com/package/balanced-match |
| `balanced-match` | 4.0.4 | https://www.npmjs.com/package/balanced-match |
| `body-parser` | 2.2.2 | https://www.npmjs.com/package/body-parser |
| `boolbase` | 1.0.0 | https://www.npmjs.com/package/boolbase |
| `bottleneck` | 2.19.5 | https://www.npmjs.com/package/bottleneck |
| `brace-expansion` | 2.1.0 | https://www.npmjs.com/package/brace-expansion |
| `brace-expansion` | 5.0.5 | https://www.npmjs.com/package/brace-expansion |
| `braces` | 3.0.3 | https://www.npmjs.com/package/braces |
| `buffer-equal-constant-time` | 1.0.1 | https://www.npmjs.com/package/buffer-equal-constant-time |
| `bytes` | 3.1.2 | https://www.npmjs.com/package/bytes |
| `bytestreamjs` | 2.0.1 | https://www.npmjs.com/package/bytestreamjs |
| `call-bind-apply-helpers` | 1.0.2 | https://www.npmjs.com/package/call-bind-apply-helpers |
| `call-bound` | 1.0.4 | https://www.npmjs.com/package/call-bound |
| `ccount` | 2.0.1 | https://www.npmjs.com/package/ccount |
| `chai` | 6.2.2 | https://www.npmjs.com/package/chai |
| `chalk` | 4.1.2 | https://www.npmjs.com/package/chalk |
| `chalk` | 5.6.2 | https://www.npmjs.com/package/chalk |
| `change-case` | 5.4.4 | https://www.npmjs.com/package/change-case |
| `character-entities-html4` | 2.1.0 | https://www.npmjs.com/package/character-entities-html4 |
| `character-entities-legacy` | 3.0.0 | https://www.npmjs.com/package/character-entities-legacy |
| `character-entities` | 2.0.2 | https://www.npmjs.com/package/character-entities |
| `chat` | 4.26.0 | https://www.npmjs.com/package/chat |
| `chokidar` | 4.0.3 | https://www.npmjs.com/package/chokidar |
| `chokidar` | 5.0.0 | https://www.npmjs.com/package/chokidar |
| `chownr` | 3.0.0 | https://www.npmjs.com/package/chownr |
| `cli-boxes` | 4.0.1 | https://www.npmjs.com/package/cli-boxes |
| `cli-cursor` | 4.0.0 | https://www.npmjs.com/package/cli-cursor |
| `cli-cursor` | 5.0.0 | https://www.npmjs.com/package/cli-cursor |
| `cli-spinners` | 3.4.0 | https://www.npmjs.com/package/cli-spinners |
| `cli-truncate` | 5.2.0 | https://www.npmjs.com/package/cli-truncate |
| `cli-truncate` | 6.0.0 | https://www.npmjs.com/package/cli-truncate |
| `cliui` | 8.0.1 | https://www.npmjs.com/package/cliui |
| `cliui` | 9.0.1 | https://www.npmjs.com/package/cliui |
| `clsx` | 2.1.1 | https://www.npmjs.com/package/clsx |
| `code-excerpt` | 4.0.0 | https://www.npmjs.com/package/code-excerpt |
| `codemirror` | 6.0.2 | https://www.npmjs.com/package/codemirror |
| `color-convert` | 2.0.1 | https://www.npmjs.com/package/color-convert |
| `color-name` | 1.1.4 | https://www.npmjs.com/package/color-name |
| `colorette` | 1.4.0 | https://www.npmjs.com/package/colorette |
| `colorette` | 2.0.20 | https://www.npmjs.com/package/colorette |
| `combined-stream` | 1.0.8 | https://www.npmjs.com/package/combined-stream |
| `comma-separated-tokens` | 2.0.3 | https://www.npmjs.com/package/comma-separated-tokens |
| `commander` | 14.0.3 | https://www.npmjs.com/package/commander |
| `concurrently` | 9.2.1 | https://www.npmjs.com/package/concurrently |
| `content-disposition` | 1.1.0 | https://www.npmjs.com/package/content-disposition |
| `content-type` | 1.0.5 | https://www.npmjs.com/package/content-type |
| `convert-source-map` | 2.0.0 | https://www.npmjs.com/package/convert-source-map |
| `convert-to-spaces` | 2.0.1 | https://www.npmjs.com/package/convert-to-spaces |
| `cookie-signature` | 1.2.2 | https://www.npmjs.com/package/cookie-signature |
| `cookie` | 0.6.0 | https://www.npmjs.com/package/cookie |
| `cookie` | 0.7.2 | https://www.npmjs.com/package/cookie |
| `cookie` | 1.1.1 | https://www.npmjs.com/package/cookie |
| `core-util-is` | 1.0.3 | https://www.npmjs.com/package/core-util-is |
| `cors` | 2.8.6 | https://www.npmjs.com/package/cors |
| `crelt` | 1.0.6 | https://www.npmjs.com/package/crelt |
| `cron-parser` | 5.5.0 | https://www.npmjs.com/package/cron-parser |
| `cross-spawn` | 7.0.6 | https://www.npmjs.com/package/cross-spawn |
| `css-select` | 5.2.2 | https://www.npmjs.com/package/css-select |
| `css-what` | 6.2.2 | https://www.npmjs.com/package/css-what |
| `cssesc` | 3.0.0 | https://www.npmjs.com/package/cssesc |
| `csstype` | 3.2.3 | https://www.npmjs.com/package/csstype |
| `debug` | 4.4.3 | https://www.npmjs.com/package/debug |
| `decode-named-character-reference` | 1.3.0 | https://www.npmjs.com/package/decode-named-character-reference |
| `dedent-js` | 1.0.1 | https://www.npmjs.com/package/dedent-js |
| `deep-is` | 0.1.4 | https://www.npmjs.com/package/deep-is |
| `deepmerge` | 4.3.1 | https://www.npmjs.com/package/deepmerge |
| `delayed-stream` | 1.0.0 | https://www.npmjs.com/package/delayed-stream |
| `depd` | 2.0.0 | https://www.npmjs.com/package/depd |
| `dequal` | 2.0.3 | https://www.npmjs.com/package/dequal |
| `devalue` | 5.7.1 | https://www.npmjs.com/package/devalue |
| `devlop` | 1.1.0 | https://www.npmjs.com/package/devlop |
| `diff` | 9.0.0 | https://www.npmjs.com/package/diff |
| `discord-api-types` | 0.37.120 | https://www.npmjs.com/package/discord-api-types |
| `discord-api-types` | 0.38.47 | https://www.npmjs.com/package/discord-api-types |
| `discord-interactions` | 4.4.0 | https://www.npmjs.com/package/discord-interactions |
| `discord.js` | 14.26.3 | https://www.npmjs.com/package/discord.js |
| `dom-serializer` | 2.0.0 | https://www.npmjs.com/package/dom-serializer |
| `domelementtype` | 2.3.0 | https://www.npmjs.com/package/domelementtype |
| `domhandler` | 5.0.3 | https://www.npmjs.com/package/domhandler |
| `dompurify` | 3.4.1 | https://www.npmjs.com/package/dompurify |
| `domutils` | 3.2.2 | https://www.npmjs.com/package/domutils |
| `dotenv` | 17.4.2 | https://www.npmjs.com/package/dotenv |
| `dunder-proto` | 1.0.1 | https://www.npmjs.com/package/dunder-proto |
| `ecdsa-sig-formatter` | 1.0.11 | https://www.npmjs.com/package/ecdsa-sig-formatter |
| `ee-first` | 1.1.1 | https://www.npmjs.com/package/ee-first |
| `emoji-regex` | 10.6.0 | https://www.npmjs.com/package/emoji-regex |
| `emoji-regex` | 8.0.0 | https://www.npmjs.com/package/emoji-regex |
| `encodeurl` | 2.0.0 | https://www.npmjs.com/package/encodeurl |
| `entities` | 4.5.0 | https://www.npmjs.com/package/entities |
| `entities` | 7.0.1 | https://www.npmjs.com/package/entities |
| `environment` | 1.1.0 | https://www.npmjs.com/package/environment |
| `es-define-property` | 1.0.1 | https://www.npmjs.com/package/es-define-property |
| `es-errors` | 1.3.0 | https://www.npmjs.com/package/es-errors |
| `es-module-lexer` | 2.1.0 | https://www.npmjs.com/package/es-module-lexer |
| `es-object-atoms` | 1.1.1 | https://www.npmjs.com/package/es-object-atoms |
| `es-set-tostringtag` | 2.1.0 | https://www.npmjs.com/package/es-set-tostringtag |
| `es-toolkit` | 1.46.0 | https://www.npmjs.com/package/es-toolkit |
| `es6-promise` | 4.2.8 | https://www.npmjs.com/package/es6-promise |
| `esbuild` | 0.27.7 | https://www.npmjs.com/package/esbuild |
| `escalade` | 3.2.0 | https://www.npmjs.com/package/escalade |
| `escape-html` | 1.0.3 | https://www.npmjs.com/package/escape-html |
| `escape-string-regexp` | 2.0.0 | https://www.npmjs.com/package/escape-string-regexp |
| `escape-string-regexp` | 4.0.0 | https://www.npmjs.com/package/escape-string-regexp |
| `escape-string-regexp` | 5.0.0 | https://www.npmjs.com/package/escape-string-regexp |
| `eslint-config-prettier` | 10.1.8 | https://www.npmjs.com/package/eslint-config-prettier |
| `eslint-plugin-svelte` | 3.17.1 | https://www.npmjs.com/package/eslint-plugin-svelte |
| `eslint-scope` | 8.4.0 | https://www.npmjs.com/package/eslint-scope |
| `eslint-scope` | 9.1.2 | https://www.npmjs.com/package/eslint-scope |
| `eslint-visitor-keys` | 3.4.3 | https://www.npmjs.com/package/eslint-visitor-keys |
| `eslint-visitor-keys` | 4.2.1 | https://www.npmjs.com/package/eslint-visitor-keys |
| `eslint-visitor-keys` | 5.0.1 | https://www.npmjs.com/package/eslint-visitor-keys |
| `eslint` | 10.2.1 | https://www.npmjs.com/package/eslint |
| `esm-env` | 1.2.2 | https://www.npmjs.com/package/esm-env |
| `espree` | 10.4.0 | https://www.npmjs.com/package/espree |
| `espree` | 11.2.0 | https://www.npmjs.com/package/espree |
| `esquery` | 1.7.0 | https://www.npmjs.com/package/esquery |
| `esrap` | 2.2.5 | https://www.npmjs.com/package/esrap |
| `esrecurse` | 4.3.0 | https://www.npmjs.com/package/esrecurse |
| `estraverse` | 5.3.0 | https://www.npmjs.com/package/estraverse |
| `estree-walker` | 3.0.3 | https://www.npmjs.com/package/estree-walker |
| `esutils` | 2.0.3 | https://www.npmjs.com/package/esutils |
| `etag` | 1.8.1 | https://www.npmjs.com/package/etag |
| `eventemitter3` | 4.0.7 | https://www.npmjs.com/package/eventemitter3 |
| `eventemitter3` | 5.0.4 | https://www.npmjs.com/package/eventemitter3 |
| `eventsource-parser` | 3.0.8 | https://www.npmjs.com/package/eventsource-parser |
| `eventsource` | 3.0.7 | https://www.npmjs.com/package/eventsource |
| `expect-type` | 1.3.0 | https://www.npmjs.com/package/expect-type |
| `express-rate-limit` | 8.4.1 | https://www.npmjs.com/package/express-rate-limit |
| `express` | 5.2.1 | https://www.npmjs.com/package/express |
| `extend` | 3.0.2 | https://www.npmjs.com/package/extend |
| `fast-deep-equal` | 3.1.3 | https://www.npmjs.com/package/fast-deep-equal |
| `fast-glob` | 3.3.3 | https://www.npmjs.com/package/fast-glob |
| `fast-json-stable-stringify` | 2.1.0 | https://www.npmjs.com/package/fast-json-stable-stringify |
| `fast-levenshtein` | 2.0.6 | https://www.npmjs.com/package/fast-levenshtein |
| `fast-uri` | 3.1.0 | https://www.npmjs.com/package/fast-uri |
| `fastq` | 1.20.1 | https://www.npmjs.com/package/fastq |
| `fd-package-json` | 2.0.0 | https://www.npmjs.com/package/fd-package-json |
| `fdir` | 6.5.0 | https://www.npmjs.com/package/fdir |
| `figures` | 6.1.0 | https://www.npmjs.com/package/figures |
| `file-entry-cache` | 8.0.0 | https://www.npmjs.com/package/file-entry-cache |
| `file-type` | 22.0.1 | https://www.npmjs.com/package/file-type |
| `fill-range` | 7.1.1 | https://www.npmjs.com/package/fill-range |
| `finalhandler` | 2.1.1 | https://www.npmjs.com/package/finalhandler |
| `find-up` | 5.0.0 | https://www.npmjs.com/package/find-up |
| `flat-cache` | 4.0.1 | https://www.npmjs.com/package/flat-cache |
| `flatted` | 3.4.2 | https://www.npmjs.com/package/flatted |
| `focus-trap` | 7.8.0 | https://www.npmjs.com/package/focus-trap |
| `follow-redirects` | 1.16.0 | https://www.npmjs.com/package/follow-redirects |
| `form-data` | 4.0.5 | https://www.npmjs.com/package/form-data |
| `formatly` | 0.3.0 | https://www.npmjs.com/package/formatly |
| `forwarded` | 0.2.0 | https://www.npmjs.com/package/forwarded |
| `fresh` | 2.0.0 | https://www.npmjs.com/package/fresh |
| `fsevents` | 2.3.3 | https://www.npmjs.com/package/fsevents |
| `function-bind` | 1.1.2 | https://www.npmjs.com/package/function-bind |
| `get-caller-file` | 2.0.5 | https://www.npmjs.com/package/get-caller-file |
| `get-east-asian-width` | 1.5.0 | https://www.npmjs.com/package/get-east-asian-width |
| `get-intrinsic` | 1.3.0 | https://www.npmjs.com/package/get-intrinsic |
| `get-proto` | 1.0.1 | https://www.npmjs.com/package/get-proto |
| `get-tsconfig` | 4.14.0 | https://www.npmjs.com/package/get-tsconfig |
| `glob-parent` | 5.1.2 | https://www.npmjs.com/package/glob-parent |
| `glob-parent` | 6.0.2 | https://www.npmjs.com/package/glob-parent |
| `globals` | 16.5.0 | https://www.npmjs.com/package/globals |
| `globals` | 17.5.0 | https://www.npmjs.com/package/globals |
| `gopd` | 1.2.0 | https://www.npmjs.com/package/gopd |
| `graceful-fs` | 4.2.11 | https://www.npmjs.com/package/graceful-fs |
| `gunshi` | 0.29.4 | https://www.npmjs.com/package/gunshi |
| `happy-dom` | 20.9.0 | https://www.npmjs.com/package/happy-dom |
| `has-flag` | 4.0.0 | https://www.npmjs.com/package/has-flag |
| `has-symbols` | 1.1.0 | https://www.npmjs.com/package/has-symbols |
| `has-tostringtag` | 1.0.2 | https://www.npmjs.com/package/has-tostringtag |
| `hasown` | 2.0.3 | https://www.npmjs.com/package/hasown |
| `hast-util-to-html` | 9.0.5 | https://www.npmjs.com/package/hast-util-to-html |
| `hast-util-whitespace` | 3.0.0 | https://www.npmjs.com/package/hast-util-whitespace |
| `he` | 1.2.0 | https://www.npmjs.com/package/he |
| `hono-openapi` | 1.3.0 | https://www.npmjs.com/package/hono-openapi |
| `hono-rate-limiter` | 0.4.2 | https://www.npmjs.com/package/hono-rate-limiter |
| `hono` | 4.12.15 | https://www.npmjs.com/package/hono |
| `html-escaper` | 2.0.2 | https://www.npmjs.com/package/html-escaper |
| `html-void-elements` | 3.0.0 | https://www.npmjs.com/package/html-void-elements |
| `http-errors` | 2.0.1 | https://www.npmjs.com/package/http-errors |
| `https-proxy-agent` | 7.0.6 | https://www.npmjs.com/package/https-proxy-agent |
| `iconv-lite` | 0.7.2 | https://www.npmjs.com/package/iconv-lite |
| `ieee754` | 1.2.1 | https://www.npmjs.com/package/ieee754 |
| `ignore` | 5.3.2 | https://www.npmjs.com/package/ignore |
| `ignore` | 7.0.5 | https://www.npmjs.com/package/ignore |
| `immediate` | 3.0.6 | https://www.npmjs.com/package/immediate |
| `immer` | 11.1.4 | https://www.npmjs.com/package/immer |
| `imurmurhash` | 0.1.4 | https://www.npmjs.com/package/imurmurhash |
| `indent-string` | 5.0.0 | https://www.npmjs.com/package/indent-string |
| `index-to-position` | 1.2.0 | https://www.npmjs.com/package/index-to-position |
| `inherits` | 2.0.4 | https://www.npmjs.com/package/inherits |
| `ink` | 7.0.1 | https://www.npmjs.com/package/ink |
| `ip-address` | 10.1.0 | https://www.npmjs.com/package/ip-address |
| `ipaddr.js` | 1.9.1 | https://www.npmjs.com/package/ipaddr.js |
| `is-electron` | 2.2.2 | https://www.npmjs.com/package/is-electron |
| `is-extglob` | 2.1.1 | https://www.npmjs.com/package/is-extglob |
| `is-fullwidth-code-point` | 3.0.0 | https://www.npmjs.com/package/is-fullwidth-code-point |
| `is-fullwidth-code-point` | 5.1.0 | https://www.npmjs.com/package/is-fullwidth-code-point |
| `is-glob` | 4.0.3 | https://www.npmjs.com/package/is-glob |
| `is-in-ci` | 2.0.0 | https://www.npmjs.com/package/is-in-ci |
| `is-number` | 7.0.0 | https://www.npmjs.com/package/is-number |
| `is-plain-obj` | 4.1.0 | https://www.npmjs.com/package/is-plain-obj |
| `is-promise` | 4.0.0 | https://www.npmjs.com/package/is-promise |
| `is-reference` | 3.0.3 | https://www.npmjs.com/package/is-reference |
| `is-stream` | 2.0.1 | https://www.npmjs.com/package/is-stream |
| `is-unicode-supported` | 2.1.0 | https://www.npmjs.com/package/is-unicode-supported |
| `isarray` | 1.0.0 | https://www.npmjs.com/package/isarray |
| `isexe` | 2.0.0 | https://www.npmjs.com/package/isexe |
| `istanbul-lib-coverage` | 3.2.2 | https://www.npmjs.com/package/istanbul-lib-coverage |
| `istanbul-lib-report` | 3.0.1 | https://www.npmjs.com/package/istanbul-lib-report |
| `istanbul-reports` | 3.2.0 | https://www.npmjs.com/package/istanbul-reports |
| `jira.js` | 5.3.1 | https://www.npmjs.com/package/jira.js |
| `jiti` | 2.6.1 | https://www.npmjs.com/package/jiti |
| `jose` | 4.15.9 | https://www.npmjs.com/package/jose |
| `jose` | 6.2.3 | https://www.npmjs.com/package/jose |
| `js-levenshtein` | 1.1.6 | https://www.npmjs.com/package/js-levenshtein |
| `js-tokens` | 10.0.0 | https://www.npmjs.com/package/js-tokens |
| `js-tokens` | 4.0.0 | https://www.npmjs.com/package/js-tokens |
| `js-yaml` | 4.1.1 | https://www.npmjs.com/package/js-yaml |
| `jsesc` | 3.1.0 | https://www.npmjs.com/package/jsesc |
| `json-buffer` | 3.0.1 | https://www.npmjs.com/package/json-buffer |
| `json-schema-to-ts` | 3.1.1 | https://www.npmjs.com/package/json-schema-to-ts |
| `json-schema-traverse` | 0.4.1 | https://www.npmjs.com/package/json-schema-traverse |
| `json-schema-traverse` | 1.0.0 | https://www.npmjs.com/package/json-schema-traverse |
| `json-schema-typed` | 8.0.2 | https://www.npmjs.com/package/json-schema-typed |
| `json-schema` | 0.4.0 | https://www.npmjs.com/package/json-schema |
| `json-stable-stringify-without-jsonify` | 1.0.1 | https://www.npmjs.com/package/json-stable-stringify-without-jsonify |
| `jsonrepair` | 3.14.0 | https://www.npmjs.com/package/jsonrepair |
| `jsonwebtoken` | 9.0.3 | https://www.npmjs.com/package/jsonwebtoken |
| `jszip` | 3.10.1 | https://www.npmjs.com/package/jszip |
| `jwa` | 2.0.1 | https://www.npmjs.com/package/jwa |
| `jwks-rsa` | 3.2.2 | https://www.npmjs.com/package/jwks-rsa |
| `jws` | 4.0.1 | https://www.npmjs.com/package/jws |
| `jwt-decode` | 4.0.0 | https://www.npmjs.com/package/jwt-decode |
| `keyv` | 4.5.4 | https://www.npmjs.com/package/keyv |
| `kleur` | 4.1.5 | https://www.npmjs.com/package/kleur |
| `knip` | 6.7.0 | https://www.npmjs.com/package/knip |
| `known-css-properties` | 0.37.0 | https://www.npmjs.com/package/known-css-properties |
| `levn` | 0.4.1 | https://www.npmjs.com/package/levn |
| `lie` | 3.3.0 | https://www.npmjs.com/package/lie |
| `lilconfig` | 2.1.0 | https://www.npmjs.com/package/lilconfig |
| `limiter` | 1.1.5 | https://www.npmjs.com/package/limiter |
| `linkify-it` | 5.0.0 | https://www.npmjs.com/package/linkify-it |
| `lint-staged` | 16.4.0 | https://www.npmjs.com/package/lint-staged |
| `listr2` | 9.0.5 | https://www.npmjs.com/package/listr2 |
| `locate-character` | 3.0.0 | https://www.npmjs.com/package/locate-character |
| `locate-path` | 6.0.0 | https://www.npmjs.com/package/locate-path |
| `lodash.clonedeep` | 4.5.0 | https://www.npmjs.com/package/lodash.clonedeep |
| `lodash.includes` | 4.3.0 | https://www.npmjs.com/package/lodash.includes |
| `lodash.isboolean` | 3.0.3 | https://www.npmjs.com/package/lodash.isboolean |
| `lodash.isinteger` | 4.0.4 | https://www.npmjs.com/package/lodash.isinteger |
| `lodash.isnumber` | 3.0.3 | https://www.npmjs.com/package/lodash.isnumber |
| `lodash.isplainobject` | 4.0.6 | https://www.npmjs.com/package/lodash.isplainobject |
| `lodash.isstring` | 4.0.1 | https://www.npmjs.com/package/lodash.isstring |
| `lodash.merge` | 4.6.2 | https://www.npmjs.com/package/lodash.merge |
| `lodash.once` | 4.1.1 | https://www.npmjs.com/package/lodash.once |
| `lodash.snakecase` | 4.1.1 | https://www.npmjs.com/package/lodash.snakecase |
| `lodash` | 4.18.1 | https://www.npmjs.com/package/lodash |
| `log-update` | 6.1.0 | https://www.npmjs.com/package/log-update |
| `long` | 5.3.2 | https://www.npmjs.com/package/long |
| `longest-streak` | 3.1.0 | https://www.npmjs.com/package/longest-streak |
| `lru-cache` | 11.3.5 | https://www.npmjs.com/package/lru-cache |
| `lru-cache` | 6.0.0 | https://www.npmjs.com/package/lru-cache |
| `lru-memoizer` | 2.3.0 | https://www.npmjs.com/package/lru-memoizer |
| `luxon` | 3.7.2 | https://www.npmjs.com/package/luxon |
| `magic-bytes.js` | 1.13.0 | https://www.npmjs.com/package/magic-bytes.js |
| `magic-string` | 0.30.21 | https://www.npmjs.com/package/magic-string |
| `magicast` | 0.5.2 | https://www.npmjs.com/package/magicast |
| `make-dir` | 4.0.0 | https://www.npmjs.com/package/make-dir |
| `markdown-it` | 14.1.1 | https://www.npmjs.com/package/markdown-it |
| `markdown-table` | 3.0.4 | https://www.npmjs.com/package/markdown-table |
| `marked` | 18.0.2 | https://www.npmjs.com/package/marked |
| `math-intrinsics` | 1.1.0 | https://www.npmjs.com/package/math-intrinsics |
| `mdast-util-find-and-replace` | 3.0.2 | https://www.npmjs.com/package/mdast-util-find-and-replace |
| `mdast-util-from-markdown` | 2.0.3 | https://www.npmjs.com/package/mdast-util-from-markdown |
| `mdast-util-gfm-autolink-literal` | 2.0.1 | https://www.npmjs.com/package/mdast-util-gfm-autolink-literal |
| `mdast-util-gfm-footnote` | 2.1.0 | https://www.npmjs.com/package/mdast-util-gfm-footnote |
| `mdast-util-gfm-strikethrough` | 2.0.0 | https://www.npmjs.com/package/mdast-util-gfm-strikethrough |
| `mdast-util-gfm-table` | 2.0.0 | https://www.npmjs.com/package/mdast-util-gfm-table |
| `mdast-util-gfm-task-list-item` | 2.0.0 | https://www.npmjs.com/package/mdast-util-gfm-task-list-item |
| `mdast-util-gfm` | 3.1.0 | https://www.npmjs.com/package/mdast-util-gfm |
| `mdast-util-phrasing` | 4.1.0 | https://www.npmjs.com/package/mdast-util-phrasing |
| `mdast-util-to-hast` | 13.2.1 | https://www.npmjs.com/package/mdast-util-to-hast |
| `mdast-util-to-markdown` | 2.1.2 | https://www.npmjs.com/package/mdast-util-to-markdown |
| `mdast-util-to-string` | 4.0.0 | https://www.npmjs.com/package/mdast-util-to-string |
| `mdurl` | 2.0.0 | https://www.npmjs.com/package/mdurl |
| `media-typer` | 1.1.0 | https://www.npmjs.com/package/media-typer |
| `merge-descriptors` | 2.0.0 | https://www.npmjs.com/package/merge-descriptors |
| `merge2` | 1.4.1 | https://www.npmjs.com/package/merge2 |
| `micromark-core-commonmark` | 2.0.3 | https://www.npmjs.com/package/micromark-core-commonmark |
| `micromark-extension-gfm-autolink-literal` | 2.1.0 | https://www.npmjs.com/package/micromark-extension-gfm-autolink-literal |
| `micromark-extension-gfm-footnote` | 2.1.0 | https://www.npmjs.com/package/micromark-extension-gfm-footnote |
| `micromark-extension-gfm-strikethrough` | 2.1.0 | https://www.npmjs.com/package/micromark-extension-gfm-strikethrough |
| `micromark-extension-gfm-table` | 2.1.1 | https://www.npmjs.com/package/micromark-extension-gfm-table |
| `micromark-extension-gfm-tagfilter` | 2.0.0 | https://www.npmjs.com/package/micromark-extension-gfm-tagfilter |
| `micromark-extension-gfm-task-list-item` | 2.1.0 | https://www.npmjs.com/package/micromark-extension-gfm-task-list-item |
| `micromark-extension-gfm` | 3.0.0 | https://www.npmjs.com/package/micromark-extension-gfm |
| `micromark-factory-destination` | 2.0.1 | https://www.npmjs.com/package/micromark-factory-destination |
| `micromark-factory-label` | 2.0.1 | https://www.npmjs.com/package/micromark-factory-label |
| `micromark-factory-space` | 2.0.1 | https://www.npmjs.com/package/micromark-factory-space |
| `micromark-factory-title` | 2.0.1 | https://www.npmjs.com/package/micromark-factory-title |
| `micromark-factory-whitespace` | 2.0.1 | https://www.npmjs.com/package/micromark-factory-whitespace |
| `micromark-util-character` | 2.1.1 | https://www.npmjs.com/package/micromark-util-character |
| `micromark-util-chunked` | 2.0.1 | https://www.npmjs.com/package/micromark-util-chunked |
| `micromark-util-classify-character` | 2.0.1 | https://www.npmjs.com/package/micromark-util-classify-character |
| `micromark-util-combine-extensions` | 2.0.1 | https://www.npmjs.com/package/micromark-util-combine-extensions |
| `micromark-util-decode-numeric-character-reference` | 2.0.2 | https://www.npmjs.com/package/micromark-util-decode-numeric-character-reference |
| `micromark-util-decode-string` | 2.0.1 | https://www.npmjs.com/package/micromark-util-decode-string |
| `micromark-util-encode` | 2.0.1 | https://www.npmjs.com/package/micromark-util-encode |
| `micromark-util-html-tag-name` | 2.0.1 | https://www.npmjs.com/package/micromark-util-html-tag-name |
| `micromark-util-normalize-identifier` | 2.0.1 | https://www.npmjs.com/package/micromark-util-normalize-identifier |
| `micromark-util-resolve-all` | 2.0.1 | https://www.npmjs.com/package/micromark-util-resolve-all |
| `micromark-util-sanitize-uri` | 2.0.1 | https://www.npmjs.com/package/micromark-util-sanitize-uri |
| `micromark-util-subtokenize` | 2.1.0 | https://www.npmjs.com/package/micromark-util-subtokenize |
| `micromark-util-symbol` | 2.0.1 | https://www.npmjs.com/package/micromark-util-symbol |
| `micromark-util-types` | 2.0.2 | https://www.npmjs.com/package/micromark-util-types |
| `micromark` | 4.0.2 | https://www.npmjs.com/package/micromark |
| `micromatch` | 4.0.8 | https://www.npmjs.com/package/micromatch |
| `mime-db` | 1.52.0 | https://www.npmjs.com/package/mime-db |
| `mime-db` | 1.54.0 | https://www.npmjs.com/package/mime-db |
| `mime-types` | 2.1.35 | https://www.npmjs.com/package/mime-types |
| `mime-types` | 3.0.2 | https://www.npmjs.com/package/mime-types |
| `mimic-fn` | 2.1.0 | https://www.npmjs.com/package/mimic-fn |
| `mimic-function` | 5.0.1 | https://www.npmjs.com/package/mimic-function |
| `minimatch` | 10.2.5 | https://www.npmjs.com/package/minimatch |
| `minimatch` | 5.1.9 | https://www.npmjs.com/package/minimatch |
| `minimist` | 1.2.8 | https://www.npmjs.com/package/minimist |
| `minipass` | 7.1.3 | https://www.npmjs.com/package/minipass |
| `minizlib` | 3.1.0 | https://www.npmjs.com/package/minizlib |
| `mri` | 1.2.0 | https://www.npmjs.com/package/mri |
| `mrmime` | 2.0.1 | https://www.npmjs.com/package/mrmime |
| `ms` | 2.1.3 | https://www.npmjs.com/package/ms |
| `nanoid` | 3.3.11 | https://www.npmjs.com/package/nanoid |
| `nanoid` | 5.1.9 | https://www.npmjs.com/package/nanoid |
| `nats` | 2.29.3 | https://www.npmjs.com/package/nats |
| `natural-compare` | 1.4.0 | https://www.npmjs.com/package/natural-compare |
| `negotiator` | 1.0.0 | https://www.npmjs.com/package/negotiator |
| `nkeys.js` | 1.1.0 | https://www.npmjs.com/package/nkeys.js |
| `node-fetch` | 2.7.0 | https://www.npmjs.com/package/node-fetch |
| `node-html-parser` | 7.1.0 | https://www.npmjs.com/package/node-html-parser |
| `nth-check` | 2.1.1 | https://www.npmjs.com/package/nth-check |
| `oauth4webapi` | 3.8.6 | https://www.npmjs.com/package/oauth4webapi |
| `object-assign` | 4.1.1 | https://www.npmjs.com/package/object-assign |
| `object-inspect` | 1.13.4 | https://www.npmjs.com/package/object-inspect |
| `obug` | 2.1.1 | https://www.npmjs.com/package/obug |
| `on-finished` | 2.4.1 | https://www.npmjs.com/package/on-finished |
| `once` | 1.4.0 | https://www.npmjs.com/package/once |
| `onetime` | 5.1.2 | https://www.npmjs.com/package/onetime |
| `onetime` | 7.0.0 | https://www.npmjs.com/package/onetime |
| `oniguruma-parser` | 0.12.2 | https://www.npmjs.com/package/oniguruma-parser |
| `oniguruma-to-es` | 4.3.6 | https://www.npmjs.com/package/oniguruma-to-es |
| `openapi-fetch` | 0.14.1 | https://www.npmjs.com/package/openapi-fetch |
| `openapi-fetch` | 0.15.2 | https://www.npmjs.com/package/openapi-fetch |
| `openapi-fetch` | 0.17.0 | https://www.npmjs.com/package/openapi-fetch |
| `openapi-types` | 12.1.3 | https://www.npmjs.com/package/openapi-types |
| `openapi-typescript-helpers` | 0.0.15 | https://www.npmjs.com/package/openapi-typescript-helpers |
| `openapi-typescript-helpers` | 0.1.0 | https://www.npmjs.com/package/openapi-typescript-helpers |
| `openapi-typescript` | 7.13.0 | https://www.npmjs.com/package/openapi-typescript |
| `optionator` | 0.9.4 | https://www.npmjs.com/package/optionator |
| `oxc-parser` | 0.127.0 | https://www.npmjs.com/package/oxc-parser |
| `oxc-resolver` | 11.19.1 | https://www.npmjs.com/package/oxc-resolver |
| `p-finally` | 1.0.0 | https://www.npmjs.com/package/p-finally |
| `p-limit` | 3.1.0 | https://www.npmjs.com/package/p-limit |
| `p-locate` | 5.0.0 | https://www.npmjs.com/package/p-locate |
| `p-queue` | 6.6.2 | https://www.npmjs.com/package/p-queue |
| `p-retry` | 4.6.2 | https://www.npmjs.com/package/p-retry |
| `p-timeout` | 3.2.0 | https://www.npmjs.com/package/p-timeout |
| `package-manager-detector` | 1.6.0 | https://www.npmjs.com/package/package-manager-detector |
| `pako` | 1.0.11 | https://www.npmjs.com/package/pako |
| `pako` | 2.1.0 | https://www.npmjs.com/package/pako |
| `papaparse` | 5.5.3 | https://www.npmjs.com/package/papaparse |
| `parallel-web` | 0.4.1 | https://www.npmjs.com/package/parallel-web |
| `parse-json` | 8.3.0 | https://www.npmjs.com/package/parse-json |
| `parseurl` | 1.3.3 | https://www.npmjs.com/package/parseurl |
| `patch-console` | 2.0.0 | https://www.npmjs.com/package/patch-console |
| `path-exists` | 4.0.0 | https://www.npmjs.com/package/path-exists |
| `path-key` | 3.1.1 | https://www.npmjs.com/package/path-key |
| `path-to-regexp` | 8.4.2 | https://www.npmjs.com/package/path-to-regexp |
| `pathe` | 2.0.3 | https://www.npmjs.com/package/pathe |
| `picocolors` | 1.1.1 | https://www.npmjs.com/package/picocolors |
| `picomatch` | 2.3.2 | https://www.npmjs.com/package/picomatch |
| `picomatch` | 4.0.4 | https://www.npmjs.com/package/picomatch |
| `pkce-challenge` | 5.0.1 | https://www.npmjs.com/package/pkce-challenge |
| `pkijs` | 3.4.0 | https://www.npmjs.com/package/pkijs |
| `pluralize` | 8.0.0 | https://www.npmjs.com/package/pluralize |
| `postcss-load-config` | 3.1.4 | https://www.npmjs.com/package/postcss-load-config |
| `postcss-safe-parser` | 7.0.1 | https://www.npmjs.com/package/postcss-safe-parser |
| `postcss-scss` | 4.0.9 | https://www.npmjs.com/package/postcss-scss |
| `postcss-selector-parser` | 7.1.1 | https://www.npmjs.com/package/postcss-selector-parser |
| `postcss` | 8.5.12 | https://www.npmjs.com/package/postcss |
| `postgres` | 3.4.9 | https://www.npmjs.com/package/postgres |
| `prelude-ls` | 1.2.1 | https://www.npmjs.com/package/prelude-ls |
| `prettier-plugin-svelte` | 3.5.1 | https://www.npmjs.com/package/prettier-plugin-svelte |
| `prettier` | 3.8.3 | https://www.npmjs.com/package/prettier |
| `process-nextick-args` | 2.0.1 | https://www.npmjs.com/package/process-nextick-args |
| `proper-lockfile` | 4.1.2 | https://www.npmjs.com/package/proper-lockfile |
| `property-information` | 7.1.0 | https://www.npmjs.com/package/property-information |
| `protobufjs` | 8.0.3 | https://www.npmjs.com/package/protobufjs |
| `proxy-addr` | 2.0.7 | https://www.npmjs.com/package/proxy-addr |
| `proxy-from-env` | 2.1.0 | https://www.npmjs.com/package/proxy-from-env |
| `publint` | 0.3.18 | https://www.npmjs.com/package/publint |
| `punycode.js` | 2.3.1 | https://www.npmjs.com/package/punycode.js |
| `punycode` | 2.3.1 | https://www.npmjs.com/package/punycode |
| `pvtsutils` | 1.3.6 | https://www.npmjs.com/package/pvtsutils |
| `pvutils` | 1.1.5 | https://www.npmjs.com/package/pvutils |
| `qs` | 6.15.1 | https://www.npmjs.com/package/qs |
| `quansync` | 0.2.11 | https://www.npmjs.com/package/quansync |
| `queue-microtask` | 1.2.3 | https://www.npmjs.com/package/queue-microtask |
| `range-parser` | 1.2.1 | https://www.npmjs.com/package/range-parser |
| `raw-body` | 3.0.2 | https://www.npmjs.com/package/raw-body |
| `react-reconciler` | 0.33.0 | https://www.npmjs.com/package/react-reconciler |
| `react` | 19.2.5 | https://www.npmjs.com/package/react |
| `readable-stream` | 2.3.8 | https://www.npmjs.com/package/readable-stream |
| `readdirp` | 4.1.2 | https://www.npmjs.com/package/readdirp |
| `readdirp` | 5.0.0 | https://www.npmjs.com/package/readdirp |
| `reflect-metadata` | 0.2.2 | https://www.npmjs.com/package/reflect-metadata |
| `regex-recursion` | 6.0.2 | https://www.npmjs.com/package/regex-recursion |
| `regex-utilities` | 2.3.0 | https://www.npmjs.com/package/regex-utilities |
| `regex` | 6.1.0 | https://www.npmjs.com/package/regex |
| `remark-gfm` | 4.0.1 | https://www.npmjs.com/package/remark-gfm |
| `remark-parse` | 11.0.0 | https://www.npmjs.com/package/remark-parse |
| `remark-stringify` | 11.0.0 | https://www.npmjs.com/package/remark-stringify |
| `remend` | 1.3.0 | https://www.npmjs.com/package/remend |
| `require-directory` | 2.1.1 | https://www.npmjs.com/package/require-directory |
| `require-from-string` | 2.0.2 | https://www.npmjs.com/package/require-from-string |
| `resolve-pkg-maps` | 1.0.0 | https://www.npmjs.com/package/resolve-pkg-maps |
| `restore-cursor` | 4.0.0 | https://www.npmjs.com/package/restore-cursor |
| `restore-cursor` | 5.1.0 | https://www.npmjs.com/package/restore-cursor |
| `retry` | 0.12.0 | https://www.npmjs.com/package/retry |
| `retry` | 0.13.1 | https://www.npmjs.com/package/retry |
| `reusify` | 1.1.0 | https://www.npmjs.com/package/reusify |
| `rfdc` | 1.4.1 | https://www.npmjs.com/package/rfdc |
| `rollup` | 4.60.2 | https://www.npmjs.com/package/rollup |
| `router` | 2.2.0 | https://www.npmjs.com/package/router |
| `run-parallel` | 1.2.0 | https://www.npmjs.com/package/run-parallel |
| `rxjs` | 7.8.2 | https://www.npmjs.com/package/rxjs |
| `sade` | 1.8.1 | https://www.npmjs.com/package/sade |
| `safe-buffer` | 5.1.2 | https://www.npmjs.com/package/safe-buffer |
| `safer-buffer` | 2.1.2 | https://www.npmjs.com/package/safer-buffer |
| `scheduler` | 0.27.0 | https://www.npmjs.com/package/scheduler |
| `scule` | 1.3.0 | https://www.npmjs.com/package/scule |
| `semver` | 7.7.4 | https://www.npmjs.com/package/semver |
| `send` | 1.2.1 | https://www.npmjs.com/package/send |
| `serve-static` | 2.2.1 | https://www.npmjs.com/package/serve-static |
| `set-cookie-parser` | 3.1.0 | https://www.npmjs.com/package/set-cookie-parser |
| `setimmediate` | 1.0.5 | https://www.npmjs.com/package/setimmediate |
| `setprototypeof` | 1.2.0 | https://www.npmjs.com/package/setprototypeof |
| `shebang-command` | 2.0.0 | https://www.npmjs.com/package/shebang-command |
| `shebang-regex` | 3.0.0 | https://www.npmjs.com/package/shebang-regex |
| `shell-quote` | 1.8.3 | https://www.npmjs.com/package/shell-quote |
| `shiki` | 4.0.2 | https://www.npmjs.com/package/shiki |
| `side-channel-list` | 1.0.1 | https://www.npmjs.com/package/side-channel-list |
| `side-channel-map` | 1.0.1 | https://www.npmjs.com/package/side-channel-map |
| `side-channel-weakmap` | 1.0.2 | https://www.npmjs.com/package/side-channel-weakmap |
| `side-channel` | 1.1.0 | https://www.npmjs.com/package/side-channel |
| `siginfo` | 2.0.0 | https://www.npmjs.com/package/siginfo |
| `signal-exit` | 3.0.7 | https://www.npmjs.com/package/signal-exit |
| `signal-exit` | 4.1.0 | https://www.npmjs.com/package/signal-exit |
| `sirv` | 3.0.2 | https://www.npmjs.com/package/sirv |
| `slice-ansi` | 7.1.2 | https://www.npmjs.com/package/slice-ansi |
| `slice-ansi` | 8.0.0 | https://www.npmjs.com/package/slice-ansi |
| `slice-ansi` | 9.0.0 | https://www.npmjs.com/package/slice-ansi |
| `smol-toml` | 1.6.1 | https://www.npmjs.com/package/smol-toml |
| `source-map-js` | 1.2.1 | https://www.npmjs.com/package/source-map-js |
| `space-separated-tokens` | 2.0.2 | https://www.npmjs.com/package/space-separated-tokens |
| `stack-utils` | 2.0.6 | https://www.npmjs.com/package/stack-utils |
| `stackback` | 0.0.2 | https://www.npmjs.com/package/stackback |
| `statuses` | 2.0.2 | https://www.npmjs.com/package/statuses |
| `std-env` | 4.1.0 | https://www.npmjs.com/package/std-env |
| `string-argv` | 0.3.2 | https://www.npmjs.com/package/string-argv |
| `string-width` | 4.2.3 | https://www.npmjs.com/package/string-width |
| `string-width` | 7.2.0 | https://www.npmjs.com/package/string-width |
| `string-width` | 8.2.1 | https://www.npmjs.com/package/string-width |
| `string_decoder` | 1.1.1 | https://www.npmjs.com/package/string_decoder |
| `stringify-entities` | 4.0.4 | https://www.npmjs.com/package/stringify-entities |
| `strip-ansi` | 6.0.1 | https://www.npmjs.com/package/strip-ansi |
| `strip-ansi` | 7.2.0 | https://www.npmjs.com/package/strip-ansi |
| `strip-json-comments` | 5.0.3 | https://www.npmjs.com/package/strip-json-comments |
| `strtok3` | 10.3.5 | https://www.npmjs.com/package/strtok3 |
| `style-mod` | 4.1.3 | https://www.npmjs.com/package/style-mod |
| `supports-color` | 10.2.2 | https://www.npmjs.com/package/supports-color |
| `supports-color` | 7.2.0 | https://www.npmjs.com/package/supports-color |
| `supports-color` | 8.1.1 | https://www.npmjs.com/package/supports-color |
| `svelte-check` | 4.4.6 | https://www.npmjs.com/package/svelte-check |
| `svelte-eslint-parser` | 1.6.0 | https://www.npmjs.com/package/svelte-eslint-parser |
| `svelte2tsx` | 0.7.53 | https://www.npmjs.com/package/svelte2tsx |
| `svelte` | 5.55.5 | https://www.npmjs.com/package/svelte |
| `tabbable` | 6.4.0 | https://www.npmjs.com/package/tabbable |
| `tagged-tag` | 1.0.0 | https://www.npmjs.com/package/tagged-tag |
| `tar` | 7.5.13 | https://www.npmjs.com/package/tar |
| `terminal-size` | 4.0.1 | https://www.npmjs.com/package/terminal-size |
| `tinybench` | 2.9.0 | https://www.npmjs.com/package/tinybench |
| `tinyexec` | 1.1.1 | https://www.npmjs.com/package/tinyexec |
| `tinyglobby` | 0.2.16 | https://www.npmjs.com/package/tinyglobby |
| `tinyrainbow` | 3.1.0 | https://www.npmjs.com/package/tinyrainbow |
| `to-regex-range` | 5.0.1 | https://www.npmjs.com/package/to-regex-range |
| `toidentifier` | 1.0.1 | https://www.npmjs.com/package/toidentifier |
| `token-types` | 6.1.2 | https://www.npmjs.com/package/token-types |
| `totalist` | 3.0.1 | https://www.npmjs.com/package/totalist |
| `tr46` | 0.0.3 | https://www.npmjs.com/package/tr46 |
| `tree-kill` | 1.2.2 | https://www.npmjs.com/package/tree-kill |
| `trim-lines` | 3.0.1 | https://www.npmjs.com/package/trim-lines |
| `trough` | 2.2.0 | https://www.npmjs.com/package/trough |
| `ts-algebra` | 2.0.0 | https://www.npmjs.com/package/ts-algebra |
| `ts-api-utils` | 2.5.0 | https://www.npmjs.com/package/ts-api-utils |
| `ts-mixer` | 6.0.4 | https://www.npmjs.com/package/ts-mixer |
| `tslib` | 2.8.1 | https://www.npmjs.com/package/tslib |
| `turndown` | 7.2.4 | https://www.npmjs.com/package/turndown |
| `tweetnacl` | 1.0.3 | https://www.npmjs.com/package/tweetnacl |
| `type-check` | 0.4.0 | https://www.npmjs.com/package/type-check |
| `type-fest` | 4.41.0 | https://www.npmjs.com/package/type-fest |
| `type-fest` | 5.6.0 | https://www.npmjs.com/package/type-fest |
| `type-is` | 2.0.1 | https://www.npmjs.com/package/type-is |
| `typescript-eslint` | 8.59.1 | https://www.npmjs.com/package/typescript-eslint |
| `typescript` | 5.9.3 | https://www.npmjs.com/package/typescript |
| `uc.micro` | 2.1.0 | https://www.npmjs.com/package/uc.micro |
| `uint8array-extras` | 1.5.0 | https://www.npmjs.com/package/uint8array-extras |
| `ulid` | 3.0.2 | https://www.npmjs.com/package/ulid |
| `unbash` | 3.0.0 | https://www.npmjs.com/package/unbash |
| `undici-types` | 7.19.2 | https://www.npmjs.com/package/undici-types |
| `undici` | 6.24.1 | https://www.npmjs.com/package/undici |
| `undici` | 7.25.0 | https://www.npmjs.com/package/undici |
| `unified` | 11.0.5 | https://www.npmjs.com/package/unified |
| `unist-util-is` | 6.0.1 | https://www.npmjs.com/package/unist-util-is |
| `unist-util-position` | 5.0.0 | https://www.npmjs.com/package/unist-util-position |
| `unist-util-stringify-position` | 4.0.0 | https://www.npmjs.com/package/unist-util-stringify-position |
| `unist-util-visit-parents` | 6.0.2 | https://www.npmjs.com/package/unist-util-visit-parents |
| `unist-util-visit` | 5.1.0 | https://www.npmjs.com/package/unist-util-visit |
| `unpipe` | 1.0.0 | https://www.npmjs.com/package/unpipe |
| `uri-js-replace` | 1.0.1 | https://www.npmjs.com/package/uri-js-replace |
| `uri-js` | 4.4.1 | https://www.npmjs.com/package/uri-js |
| `util-deprecate` | 1.0.2 | https://www.npmjs.com/package/util-deprecate |
| `uuid` | 8.3.2 | https://www.npmjs.com/package/uuid |
| `vary` | 1.1.2 | https://www.npmjs.com/package/vary |
| `vfile-message` | 4.0.3 | https://www.npmjs.com/package/vfile-message |
| `vfile` | 6.0.3 | https://www.npmjs.com/package/vfile |
| `vite` | 7.3.2 | https://www.npmjs.com/package/vite |
| `vitefu` | 1.1.3 | https://www.npmjs.com/package/vitefu |
| `vitest` | 4.1.5 | https://www.npmjs.com/package/vitest |
| `w3c-keyname` | 2.2.8 | https://www.npmjs.com/package/w3c-keyname |
| `walk-up-path` | 4.0.0 | https://www.npmjs.com/package/walk-up-path |
| `webidl-conversions` | 3.0.1 | https://www.npmjs.com/package/webidl-conversions |
| `whatwg-mimetype` | 3.0.0 | https://www.npmjs.com/package/whatwg-mimetype |
| `whatwg-url` | 5.0.0 | https://www.npmjs.com/package/whatwg-url |
| `which` | 2.0.2 | https://www.npmjs.com/package/which |
| `why-is-node-running` | 2.3.0 | https://www.npmjs.com/package/why-is-node-running |
| `widest-line` | 6.0.0 | https://www.npmjs.com/package/widest-line |
| `word-wrap` | 1.2.5 | https://www.npmjs.com/package/word-wrap |
| `wrap-ansi` | 10.0.0 | https://www.npmjs.com/package/wrap-ansi |
| `wrap-ansi` | 7.0.0 | https://www.npmjs.com/package/wrap-ansi |
| `wrap-ansi` | 9.0.2 | https://www.npmjs.com/package/wrap-ansi |
| `wrappy` | 1.0.2 | https://www.npmjs.com/package/wrappy |
| `ws` | 8.20.0 | https://www.npmjs.com/package/ws |
| `xstate` | 5.31.0 | https://www.npmjs.com/package/xstate |
| `y18n` | 5.0.8 | https://www.npmjs.com/package/y18n |
| `yallist` | 4.0.0 | https://www.npmjs.com/package/yallist |
| `yallist` | 5.0.0 | https://www.npmjs.com/package/yallist |
| `yaml-ast-parser` | 0.0.43 | https://www.npmjs.com/package/yaml-ast-parser |
| `yaml` | 1.10.3 | https://www.npmjs.com/package/yaml |
| `yaml` | 2.8.3 | https://www.npmjs.com/package/yaml |
| `yargs-parser` | 21.1.1 | https://www.npmjs.com/package/yargs-parser |
| `yargs-parser` | 22.0.0 | https://www.npmjs.com/package/yargs-parser |
| `yargs` | 17.7.2 | https://www.npmjs.com/package/yargs |
| `yargs` | 18.0.0 | https://www.npmjs.com/package/yargs |
| `yocto-queue` | 0.1.0 | https://www.npmjs.com/package/yocto-queue |
| `yoga-layout` | 3.2.1 | https://www.npmjs.com/package/yoga-layout |
| `zimmerframe` | 1.1.4 | https://www.npmjs.com/package/zimmerframe |
| `zod-to-json-schema` | 3.25.2 | https://www.npmjs.com/package/zod-to-json-schema |
| `zod` | 4.3.6 | https://www.npmjs.com/package/zod |
| `zwitch` | 2.0.4 | https://www.npmjs.com/package/zwitch |
| `@db/sqlite` | 0.13.0 | https://jsr.io/@db/sqlite |
| `@denosaurs/plug` | 1.1.0 | https://jsr.io/@denosaurs/plug |
| `@std/assert` | 1.0.19 | https://jsr.io/@std/assert |
| `@std/async` | 1.3.0 | https://jsr.io/@std/async |
| `@std/cli` | 1.0.29 | https://jsr.io/@std/cli |
| `@std/data-structures` | 1.0.11 | https://jsr.io/@std/data-structures |
| `@std/dotenv` | 0.225.6 | https://jsr.io/@std/dotenv |
| `@std/encoding` | 1.0.10 | https://jsr.io/@std/encoding |
| `@std/fmt` | 1.0.10 | https://jsr.io/@std/fmt |
| `@std/fs` | 1.0.23 | https://jsr.io/@std/fs |
| `@std/internal` | 1.0.13 | https://jsr.io/@std/internal |
| `@std/media-types` | 1.1.0 | https://jsr.io/@std/media-types |
| `@std/path` | 1.0.9 | https://jsr.io/@std/path |
| `@std/path` | 1.1.4 | https://jsr.io/@std/path |
| `@std/streams` | 1.1.0 | https://jsr.io/@std/streams |
| `@std/tar` | 0.1.10 | https://jsr.io/@std/tar |
| `@std/testing` | 1.0.18 | https://jsr.io/@std/testing |
| `@std/yaml` | 1.1.0 | https://jsr.io/@std/yaml |

## How to retrieve full license text

The table above lists each dependency's SPDX license identifier and source URL.
The full license text for any individual package can be fetched from:

- **Go modules**: `$(go env GOPATH)/pkg/mod/<module>@<version>/LICENSE`
- **Rust crates**: `~/.cargo/registry/src/index.crates.io-*/<crate>-<version>/LICENSE*`
- **npm packages**: `<package_url>` or the package's GitHub repository
- **JSR packages**: the `license` field on the package's jsr.io page

Release artifacts (Tauri installer, compiled Go binaries) bundle their full
license texts under their respective resources directories per the Apache-2.0,
MIT, and BSD attribution requirements.

Generated: 2026-04-30
