FROM tsl0922/ttyd:alpine

RUN apk add --no-cache bash git openssh-client tmux

WORKDIR /workspace

CMD ["ttyd", "--writable", "--port", "7681", "tmux", "new-session", "-A", "-s", "webssh"]
