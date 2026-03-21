module github.com/tempestteam/atlas

go 1.25.4

require (
	cloud.google.com/go/auth v0.18.2
	cloud.google.com/go/bigquery v1.74.0
	cloud.google.com/go/profiler v0.4.3
	cloud.google.com/go/secretmanager v1.16.0
	cloud.google.com/go/storage v1.61.3
	github.com/caarlos0/env/v11 v11.4.0
	github.com/ggicci/httpin v0.20.3
	github.com/go-chi/chi/v5 v5.2.5
	github.com/go-chi/cors v1.2.2
	github.com/go-chi/httplog/v2 v2.1.1
	github.com/go-chi/jwtauth/v5 v5.4.0
	github.com/go-playground/validator/v10 v10.30.1
	github.com/golang-jwt/jwt/v5 v5.3.1
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.8.0
	github.com/joho/godotenv v1.5.1
	github.com/k3a/html2text v1.4.0
	github.com/open-telemetry/opentelemetry-collector-contrib/exporter/googlecloudexporter v0.148.0
	github.com/open-telemetry/opentelemetry-collector-contrib/exporter/prometheusexporter v0.148.0
	github.com/open-telemetry/opentelemetry-collector-contrib/extension/healthcheckextension v0.148.0
	github.com/open-telemetry/opentelemetry-collector-contrib/processor/filterprocessor v0.148.0
	github.com/open-telemetry/opentelemetry-collector-contrib/processor/resourceprocessor v0.148.0
	github.com/open-telemetry/opentelemetry-collector-contrib/processor/transformprocessor v0.148.0
	github.com/phuslu/lru v1.0.18
	github.com/prometheus/client_golang v1.23.2
	github.com/sendgrid/rest v2.6.9+incompatible
	github.com/sendgrid/sendgrid-go v3.16.1+incompatible
	github.com/slack-go/slack v0.19.0
	github.com/spf13/cobra v1.10.2
	github.com/stretchr/testify v1.11.1
	github.com/stripe/stripe-go/v84 v84.4.1
	github.com/tink-crypto/tink-go-gcpkms/v2 v2.2.0
	github.com/tink-crypto/tink-go/v2 v2.6.0
	go.opentelemetry.io/collector/component v1.54.0
	go.opentelemetry.io/collector/config/configretry v1.54.0
	go.opentelemetry.io/collector/config/configtls v1.54.0
	go.opentelemetry.io/collector/confmap v1.54.0
	go.opentelemetry.io/collector/confmap/provider/envprovider v1.54.0
	go.opentelemetry.io/collector/confmap/provider/fileprovider v1.54.0
	go.opentelemetry.io/collector/exporter v1.54.0
	go.opentelemetry.io/collector/exporter/debugexporter v0.148.0
	go.opentelemetry.io/collector/exporter/exporterhelper v0.148.0
	go.opentelemetry.io/collector/exporter/otlpexporter v0.148.0
	go.opentelemetry.io/collector/exporter/otlphttpexporter v0.148.0
	go.opentelemetry.io/collector/extension v1.54.0
	go.opentelemetry.io/collector/extension/zpagesextension v0.148.0
	go.opentelemetry.io/collector/otelcol v0.148.0
	go.opentelemetry.io/collector/pdata v1.54.0
	go.opentelemetry.io/collector/processor v1.54.0
	go.opentelemetry.io/collector/processor/batchprocessor v0.148.0
	go.opentelemetry.io/collector/receiver v1.54.0
	go.opentelemetry.io/collector/receiver/otlpreceiver v0.148.0
	go.opentelemetry.io/collector/service v0.148.0
	go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp v0.18.0
	go.opentelemetry.io/otel/log v0.18.0
	go.opentelemetry.io/otel/sdk/log v0.18.0
	go.uber.org/zap v1.27.1
	golang.org/x/oauth2 v0.36.0
	google.golang.org/api v0.272.0
	k8s.io/apimachinery v0.35.3
	k8s.io/client-go v0.35.3
)

require (
	cel.dev/expr v0.25.1 // indirect
	cloud.google.com/go v0.123.0 // indirect
	cloud.google.com/go/auth/oauth2adapt v0.2.8 // indirect
	cloud.google.com/go/compute/metadata v0.9.0 // indirect
	cloud.google.com/go/iam v1.5.3 // indirect
	cloud.google.com/go/logging v1.13.2 // indirect
	cloud.google.com/go/longrunning v0.8.0 // indirect
	cloud.google.com/go/monitoring v1.24.3 // indirect
	cloud.google.com/go/trace v1.11.7 // indirect
	github.com/Azure/azure-sdk-for-go/sdk/azcore v1.21.0 // indirect
	github.com/Azure/azure-sdk-for-go/sdk/azidentity v1.13.1 // indirect
	github.com/Azure/azure-sdk-for-go/sdk/internal v1.11.2 // indirect
	github.com/AzureAD/microsoft-authentication-library-for-go v1.6.0 // indirect
	github.com/GoogleCloudPlatform/opentelemetry-operations-go/detectors/gcp v1.30.0 // indirect
	github.com/GoogleCloudPlatform/opentelemetry-operations-go/exporter/collector v0.55.0 // indirect
	github.com/GoogleCloudPlatform/opentelemetry-operations-go/exporter/metric v0.55.0 // indirect
	github.com/GoogleCloudPlatform/opentelemetry-operations-go/exporter/trace v1.31.0 // indirect
	github.com/GoogleCloudPlatform/opentelemetry-operations-go/internal/resourcemapping v0.55.0 // indirect
	github.com/alecthomas/participle/v2 v2.1.4 // indirect
	github.com/alecthomas/units v0.0.0-20240927000941-0f3dac36c52b // indirect
	github.com/antchfx/xmlquery v1.5.0 // indirect
	github.com/antchfx/xpath v1.3.6 // indirect
	github.com/apache/arrow/go/v15 v15.0.2 // indirect
	github.com/aws/aws-sdk-go-v2 v1.41.1 // indirect
	github.com/aws/aws-sdk-go-v2/config v1.32.7 // indirect
	github.com/aws/aws-sdk-go-v2/credentials v1.19.7 // indirect
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.18.17 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.4.17 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.7.17 // indirect
	github.com/aws/aws-sdk-go-v2/internal/ini v1.8.4 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.13.4 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.13.17 // indirect
	github.com/aws/aws-sdk-go-v2/service/signin v1.0.5 // indirect
	github.com/aws/aws-sdk-go-v2/service/sso v1.30.9 // indirect
	github.com/aws/aws-sdk-go-v2/service/ssooidc v1.35.13 // indirect
	github.com/aws/aws-sdk-go-v2/service/sts v1.41.6 // indirect
	github.com/aws/smithy-go v1.24.0 // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/cenkalti/backoff/v5 v5.0.3 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/cncf/xds/go v0.0.0-20251210132809-ee656c7534f5 // indirect
	github.com/davecgh/go-spew v1.1.2-0.20180830191138-d8f796af33cc // indirect
	github.com/decred/dcrd/dcrec/secp256k1/v4 v4.4.0 // indirect
	github.com/dennwc/varint v1.0.0 // indirect
	github.com/ebitengine/purego v0.10.0 // indirect
	github.com/elastic/go-grok v0.3.1 // indirect
	github.com/elastic/lunes v0.2.0 // indirect
	github.com/envoyproxy/go-control-plane/envoy v1.36.0 // indirect
	github.com/envoyproxy/protoc-gen-validate v1.3.0 // indirect
	github.com/expr-lang/expr v1.17.8 // indirect
	github.com/felixge/httpsnoop v1.0.4 // indirect
	github.com/foxboron/go-tpm-keyfiles v0.0.0-20251226215517-609e4778396f // indirect
	github.com/fsnotify/fsnotify v1.9.0 // indirect
	github.com/fxamacker/cbor/v2 v2.9.0 // indirect
	github.com/gabriel-vasile/mimetype v1.4.12 // indirect
	github.com/ggicci/owl v0.8.2 // indirect
	github.com/go-jose/go-jose/v4 v4.1.3 // indirect
	github.com/go-logr/logr v1.4.3 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/go-ole/go-ole v1.2.6 // indirect
	github.com/go-openapi/jsonpointer v0.22.4 // indirect
	github.com/go-openapi/jsonreference v0.21.4 // indirect
	github.com/go-openapi/swag v0.25.4 // indirect
	github.com/go-openapi/swag/cmdutils v0.25.4 // indirect
	github.com/go-openapi/swag/conv v0.25.4 // indirect
	github.com/go-openapi/swag/fileutils v0.25.4 // indirect
	github.com/go-openapi/swag/jsonname v0.25.4 // indirect
	github.com/go-openapi/swag/jsonutils v0.25.4 // indirect
	github.com/go-openapi/swag/loading v0.25.4 // indirect
	github.com/go-openapi/swag/mangling v0.25.4 // indirect
	github.com/go-openapi/swag/netutils v0.25.4 // indirect
	github.com/go-openapi/swag/stringutils v0.25.4 // indirect
	github.com/go-openapi/swag/typeutils v0.25.4 // indirect
	github.com/go-openapi/swag/yamlutils v0.25.4 // indirect
	github.com/go-playground/locales v0.14.1 // indirect
	github.com/go-playground/universal-translator v0.18.1 // indirect
	github.com/go-viper/mapstructure/v2 v2.5.0 // indirect
	github.com/gobwas/glob v0.2.3 // indirect
	github.com/goccy/go-json v0.10.5 // indirect
	github.com/golang/groupcache v0.0.0-20241129210726-2c02b8208cf8 // indirect
	github.com/golang/snappy v1.0.0 // indirect
	github.com/google/flatbuffers v23.5.26+incompatible // indirect
	github.com/google/gnostic-models v0.7.0 // indirect
	github.com/google/go-tpm v0.9.8 // indirect
	github.com/google/pprof v0.0.0-20260202012954-cb029daf43ef // indirect
	github.com/google/s2a-go v0.1.9 // indirect
	github.com/googleapis/enterprise-certificate-proxy v0.3.14 // indirect
	github.com/googleapis/gax-go/v2 v2.18.0 // indirect
	github.com/gorilla/websocket v1.5.4-0.20250319132907-e064f32e3674 // indirect
	github.com/grafana/regexp v0.0.0-20250905093917-f7b3be9d1853 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.28.0 // indirect
	github.com/hashicorp/go-version v1.8.0 // indirect
	github.com/hashicorp/golang-lru v1.0.2 // indirect
	github.com/hashicorp/golang-lru/v2 v2.0.7 // indirect
	github.com/iancoleman/strcase v0.3.0 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/jpillora/backoff v1.0.0 // indirect
	github.com/json-iterator/go v1.1.12 // indirect
	github.com/klauspost/compress v1.18.4 // indirect
	github.com/klauspost/cpuid/v2 v2.3.0 // indirect
	github.com/knadh/koanf/maps v0.1.2 // indirect
	github.com/knadh/koanf/providers/confmap v1.0.0 // indirect
	github.com/knadh/koanf/v2 v2.3.3 // indirect
	github.com/kylelemons/godebug v1.1.0 // indirect
	github.com/leodido/go-urn v1.4.0 // indirect
	github.com/lestrrat-go/blackmagic v1.0.4 // indirect
	github.com/lestrrat-go/httpcc v1.0.1 // indirect
	github.com/lestrrat-go/httprc/v3 v3.0.0-beta2 // indirect
	github.com/lestrrat-go/jwx/v3 v3.0.2 // indirect
	github.com/lestrrat-go/option v1.0.1 // indirect
	github.com/lightstep/go-expohisto v1.0.0 // indirect
	github.com/lufia/plan9stats v0.0.0-20251013123823-9fd1530e3ec3 // indirect
	github.com/magefile/mage v1.15.0 // indirect
	github.com/mitchellh/copystructure v1.2.0 // indirect
	github.com/mitchellh/reflectwalk v1.0.2 // indirect
	github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd // indirect
	github.com/modern-go/reflect2 v1.0.3-0.20250322232337-35a7c28c31ee // indirect
	github.com/mostynb/go-grpc-compression v1.2.3 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/mwitkow/go-conntrack v0.0.0-20190716064945-2f068394615f // indirect
	github.com/open-telemetry/opentelemetry-collector-contrib/internal/common v0.148.0 // indirect
	github.com/open-telemetry/opentelemetry-collector-contrib/internal/coreinternal v0.148.0 // indirect
	github.com/open-telemetry/opentelemetry-collector-contrib/internal/filter v0.148.0 // indirect
	github.com/open-telemetry/opentelemetry-collector-contrib/internal/healthcheck v0.148.0 // indirect
	github.com/open-telemetry/opentelemetry-collector-contrib/internal/pdatautil v0.148.0 // indirect
	github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl v0.148.0 // indirect
	github.com/open-telemetry/opentelemetry-collector-contrib/pkg/pdatautil v0.148.0 // indirect
	github.com/open-telemetry/opentelemetry-collector-contrib/pkg/resourcetotelemetry v0.148.0 // indirect
	github.com/open-telemetry/opentelemetry-collector-contrib/pkg/status v0.148.0 // indirect
	github.com/open-telemetry/opentelemetry-collector-contrib/pkg/translator/prometheus v0.148.0 // indirect
	github.com/pierrec/lz4/v4 v4.1.26 // indirect
	github.com/pkg/browser v0.0.0-20240102092130-5ac0b6a4141c // indirect
	github.com/planetscale/vtprotobuf v0.6.1-0.20240319094008-0393e58bdf10 // indirect
	github.com/pmezard/go-difflib v1.0.1-0.20181226105442-5d4384ee4fb2 // indirect
	github.com/power-devops/perfstat v0.0.0-20240221224432-82ca36839d55 // indirect
	github.com/prometheus/client_golang/exp v0.0.0-20260108101519-fb0838f53562 // indirect
	github.com/prometheus/client_model v0.6.2 // indirect
	github.com/prometheus/common v0.67.5 // indirect
	github.com/prometheus/otlptranslator v1.0.0 // indirect
	github.com/prometheus/procfs v0.20.1 // indirect
	github.com/prometheus/prometheus v0.310.0 // indirect
	github.com/prometheus/sigv4 v0.4.1 // indirect
	github.com/rs/cors v1.11.1 // indirect
	github.com/segmentio/asm v1.2.1 // indirect
	github.com/shirou/gopsutil/v4 v4.26.2 // indirect
	github.com/spf13/pflag v1.0.10 // indirect
	github.com/spiffe/go-spiffe/v2 v2.6.0 // indirect
	github.com/tidwall/gjson v1.18.0 // indirect
	github.com/tidwall/match v1.2.0 // indirect
	github.com/tidwall/pretty v1.2.1 // indirect
	github.com/tidwall/tinylru v1.2.1 // indirect
	github.com/tidwall/wal v1.2.1 // indirect
	github.com/tklauser/go-sysconf v0.3.16 // indirect
	github.com/tklauser/numcpus v0.11.0 // indirect
	github.com/twmb/murmur3 v1.1.8 // indirect
	github.com/ua-parser/uap-go v0.0.0-20251207011819-db9adb27a0b8 // indirect
	github.com/x448/float16 v0.8.4 // indirect
	github.com/yusufpapurcu/wmi v1.2.4 // indirect
	github.com/zeebo/xxh3 v1.1.0 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/collector v0.148.0 // indirect
	go.opentelemetry.io/collector/client v1.54.0 // indirect
	go.opentelemetry.io/collector/component/componentstatus v0.148.0 // indirect
	go.opentelemetry.io/collector/component/componenttest v0.148.0 // indirect
	go.opentelemetry.io/collector/config/configauth v1.54.0 // indirect
	go.opentelemetry.io/collector/config/configcompression v1.54.0 // indirect
	go.opentelemetry.io/collector/config/configgrpc v0.148.0 // indirect
	go.opentelemetry.io/collector/config/confighttp v0.148.0 // indirect
	go.opentelemetry.io/collector/config/configmiddleware v1.54.0 // indirect
	go.opentelemetry.io/collector/config/confignet v1.54.0 // indirect
	go.opentelemetry.io/collector/config/configopaque v1.54.0 // indirect
	go.opentelemetry.io/collector/config/configoptional v1.54.0 // indirect
	go.opentelemetry.io/collector/config/configtelemetry v0.148.0 // indirect
	go.opentelemetry.io/collector/confmap/xconfmap v0.148.0 // indirect
	go.opentelemetry.io/collector/connector v0.148.0 // indirect
	go.opentelemetry.io/collector/connector/connectortest v0.148.0 // indirect
	go.opentelemetry.io/collector/connector/xconnector v0.148.0 // indirect
	go.opentelemetry.io/collector/consumer v1.54.0 // indirect
	go.opentelemetry.io/collector/consumer/consumererror v0.148.0 // indirect
	go.opentelemetry.io/collector/consumer/consumererror/xconsumererror v0.148.0 // indirect
	go.opentelemetry.io/collector/consumer/consumertest v0.148.0 // indirect
	go.opentelemetry.io/collector/consumer/xconsumer v0.148.0 // indirect
	go.opentelemetry.io/collector/exporter/exporterhelper/xexporterhelper v0.148.0 // indirect
	go.opentelemetry.io/collector/exporter/exportertest v0.148.0 // indirect
	go.opentelemetry.io/collector/exporter/xexporter v0.148.0 // indirect
	go.opentelemetry.io/collector/extension/extensionauth v1.54.0 // indirect
	go.opentelemetry.io/collector/extension/extensioncapabilities v0.148.0 // indirect
	go.opentelemetry.io/collector/extension/extensionmiddleware v0.148.0 // indirect
	go.opentelemetry.io/collector/extension/extensiontest v0.148.0 // indirect
	go.opentelemetry.io/collector/extension/xextension v0.148.0 // indirect
	go.opentelemetry.io/collector/featuregate v1.54.0 // indirect
	go.opentelemetry.io/collector/internal/componentalias v0.148.0 // indirect
	go.opentelemetry.io/collector/internal/fanoutconsumer v0.148.0 // indirect
	go.opentelemetry.io/collector/internal/sharedcomponent v0.148.0 // indirect
	go.opentelemetry.io/collector/internal/telemetry v0.148.0 // indirect
	go.opentelemetry.io/collector/pdata/pprofile v0.148.0 // indirect
	go.opentelemetry.io/collector/pdata/testdata v0.148.0 // indirect
	go.opentelemetry.io/collector/pdata/xpdata v0.148.0 // indirect
	go.opentelemetry.io/collector/pipeline v1.54.0 // indirect
	go.opentelemetry.io/collector/pipeline/xpipeline v0.148.0 // indirect
	go.opentelemetry.io/collector/processor/processorhelper v0.148.0 // indirect
	go.opentelemetry.io/collector/processor/processorhelper/xprocessorhelper v0.148.0 // indirect
	go.opentelemetry.io/collector/processor/processortest v0.148.0 // indirect
	go.opentelemetry.io/collector/processor/xprocessor v0.148.0 // indirect
	go.opentelemetry.io/collector/receiver/receiverhelper v0.148.0 // indirect
	go.opentelemetry.io/collector/receiver/receivertest v0.148.0 // indirect
	go.opentelemetry.io/collector/receiver/xreceiver v0.148.0 // indirect
	go.opentelemetry.io/collector/service/hostcapabilities v0.148.0 // indirect
	go.opentelemetry.io/contrib/bridges/otelzap v0.17.0 // indirect
	go.opentelemetry.io/contrib/detectors/gcp v1.39.0 // indirect
	go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc v0.67.0 // indirect
	go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.67.0 // indirect
	go.opentelemetry.io/contrib/otelconf v0.22.0 // indirect
	go.opentelemetry.io/contrib/propagators/b3 v1.42.0 // indirect
	go.opentelemetry.io/contrib/zpages v0.67.0 // indirect
	go.opentelemetry.io/otel v1.42.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc v0.18.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc v1.42.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp v1.42.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace v1.42.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.42.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.42.0 // indirect
	go.opentelemetry.io/otel/exporters/prometheus v0.64.0 // indirect
	go.opentelemetry.io/otel/exporters/stdout/stdoutlog v0.18.0 // indirect
	go.opentelemetry.io/otel/exporters/stdout/stdoutmetric v1.42.0 // indirect
	go.opentelemetry.io/otel/exporters/stdout/stdouttrace v1.42.0 // indirect
	go.opentelemetry.io/otel/metric v1.42.0 // indirect
	go.opentelemetry.io/otel/sdk v1.42.0 // indirect
	go.opentelemetry.io/otel/sdk/metric v1.42.0 // indirect
	go.opentelemetry.io/otel/trace v1.42.0 // indirect
	go.opentelemetry.io/proto/otlp v1.10.0 // indirect
	go.uber.org/atomic v1.11.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	go.yaml.in/yaml/v2 v2.4.3 // indirect
	go.yaml.in/yaml/v3 v3.0.4 // indirect
	golang.org/x/crypto v0.49.0 // indirect
	golang.org/x/exp v0.0.0-20260218203240-3dfff04db8fa // indirect
	golang.org/x/mod v0.33.0 // indirect
	golang.org/x/net v0.52.0 // indirect
	golang.org/x/sync v0.20.0 // indirect
	golang.org/x/sys v0.42.0 // indirect
	golang.org/x/telemetry v0.0.0-20260209163413-e7419c687ee4 // indirect
	golang.org/x/term v0.41.0 // indirect
	golang.org/x/text v0.35.0 // indirect
	golang.org/x/time v0.15.0 // indirect
	golang.org/x/tools v0.42.0 // indirect
	golang.org/x/xerrors v0.0.0-20240903120638-7835f813f4da // indirect
	gonum.org/v1/gonum v0.17.0 // indirect
	google.golang.org/genproto v0.0.0-20260217215200-42d3e9bedb6d // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20260226221140-a57be14db171 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260311181403-84a4fc48630c // indirect
	google.golang.org/grpc v1.79.3 // indirect
	google.golang.org/protobuf v1.36.11 // indirect
	gopkg.in/evanphx/json-patch.v4 v4.13.0 // indirect
	gopkg.in/inf.v0 v0.9.1 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	k8s.io/klog/v2 v2.130.1 // indirect
	k8s.io/kube-openapi v0.0.0-20250910181357-589584f1c912 // indirect
	k8s.io/utils v0.0.0-20251002143259-bc988d571ff4 // indirect
	sigs.k8s.io/json v0.0.0-20250730193827-2d320260d730 // indirect
	sigs.k8s.io/randfill v1.0.0 // indirect
	sigs.k8s.io/structured-merge-diff/v6 v6.3.1 // indirect
	sigs.k8s.io/yaml v1.6.0 // indirect
)
