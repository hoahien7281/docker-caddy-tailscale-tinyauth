# __APP_NAME__/Dockerfile — built image for app "__APP_NAME__"
# Edit to suit your app. Keep the exposed/listen port = __APP_PORT__ (matches the
# Caddy label in __APP_NAME__.yml). Prefer a small base image for fast CI builds.

FROM alpine:3.20

RUN apk add --no-cache ca-certificates

WORKDIR /app

# COPY your build artifacts here, e.g.:
# COPY . /app

# The container must listen on port __APP_PORT__ on 0.0.0.0.
EXPOSE __APP_PORT__

CMD ["sh", "-c", "echo 'replace me: start your server on 0.0.0.0:__APP_PORT__' && sleep infinity"]
