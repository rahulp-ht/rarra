FROM nginx:1.28-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html style.css tasks.js /usr/share/nginx/html/
RUN cd /usr/share/nginx/html \
    && style_hash="$(sha256sum style.css | cut -d ' ' -f 1)" \
    && script_hash="$(sha256sum tasks.js | cut -d ' ' -f 1)" \
    && sed -i "s/__STYLE_HASH__/$style_hash/g; s/__SCRIPT_HASH__/$script_hash/g" index.html
EXPOSE 8080
