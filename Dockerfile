FROM node:24-alpine

WORKDIR /app

# Dependencies first, so source edits don't reinstall the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=7070
ENV SESSION_DIR=/app/sessions
EXPOSE 7070

# Schema migration, socket resume and the send loop all start with the server
# (see instrumentation.ts). There is no separate worker to run.
#
# Next is executed directly rather than through `npm run start` so that node is
# PID 1 and receives SIGTERM itself. npm does not reliably pass signals to its
# child, and without the signal the shutdown handler never runs, so every restart
# would kill the WhatsApp sockets mid-flight.
CMD ["node_modules/.bin/next", "start"]
