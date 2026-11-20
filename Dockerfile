# The first stage builds the static site from source; the second serves it with Caddy on
# port 3000. Nothing else runs: the splats stream straight from PlayCanvas's CDN to the
# visitor's browser.
#   docker build -t heartwood .
#   docker run --rm -p 127.0.0.1:8080:3000 heartwood
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM caddy:2.11.9
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/dist /srv
EXPOSE 3000
