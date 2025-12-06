FROM node:22-alpine

WORKDIR /app

# Copy dependency definitions
COPY app/package*.json ./

# Install production dependencies
RUN npm install --production

# Copy source code
COPY app/ .

# Create data directory
RUN mkdir -p data

# Expose port
EXPOSE 7080

# Start server
CMD ["node", "server.js"]