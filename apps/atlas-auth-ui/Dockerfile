FROM nginxinc/nginx-unprivileged:1.29.2-alpine3.22

# Copy static files
COPY public /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/nginx.conf

CMD ["nginx", "-g", "daemon off;"]
