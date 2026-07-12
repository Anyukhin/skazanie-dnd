FROM alpine:3.22.5

RUN apk add --no-cache openssh-client

COPY tunnel/pinggy.sh /usr/local/bin/pinggy-tunnel
RUN chmod 0555 /usr/local/bin/pinggy-tunnel

ENTRYPOINT ["/usr/local/bin/pinggy-tunnel"]
