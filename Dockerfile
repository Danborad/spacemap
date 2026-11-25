# 编译阶段
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS builder

ARG TARGETOS=linux
ARG TARGETARCH

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY VERSION ./
COPY cmd ./cmd
COPY internal ./internal
COPY web ./web

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -ldflags="-s -w" -o /out/spacemap ./cmd/spacemap

# 运行阶段
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /out/spacemap /app/spacemap
COPY VERSION /app/VERSION

RUN mkdir -p /app/data

ENV PORT=7080
ENV DATA_DIR=/app/data
ENV DOCKER_CONTAINER=1

EXPOSE 7080

CMD ["/app/spacemap"]
