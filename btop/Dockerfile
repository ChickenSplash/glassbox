FROM alpine:3.22

RUN apk add --no-cache btop socat tzdata \
 && mkdir -p /run/btop \
 && chown 1000:1000 /run/btop

COPY btop.conf /etc/glassbox/btop/btop.conf
COPY run-btop /usr/local/bin/run-btop

# btop reads its config from $XDG_CONFIG_HOME/btop and keeps logs under $HOME
ENV XDG_CONFIG_HOME=/etc/glassbox \
    HOME=/tmp \
    TERM=xterm-256color \
    LANG=C.UTF-8

USER 1000:1000

# One btop per connection on a fresh pty. Only the glassbox service connects, and it
# never writes, so nothing a visitor does can reach btop.
CMD ["socat", "UNIX-LISTEN:/run/btop/btop.sock,mode=600,unlink-early,fork,max-children=1", "EXEC:/usr/local/bin/run-btop,pty,setsid,ctty,stderr"]
