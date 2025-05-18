# Gaza Name Project

![screencapture-localhost-3000-2025-05-18-02_22_41](https://github.com/user-attachments/assets/10ebc083-08d0-4a35-97be-0bcd4c21a6b0)

A full-stack application for recording and managing names, built with Next.js, Node.js, and PostgreSQL.

## Project Overview

This project consists of:
- Frontend: Next.js application with TypeScript
- Backend: Node.js API server
- Database: PostgreSQL
- Audio Processing: FFmpeg for audio file handling

## Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for local development)
- pnpm (recommended) or npm
- FFmpeg (for local development)

## Quick Start with Docker

1. Clone the repository:
```bash
git clone [repository-url]
cd gaza-name-project
```

2. Start all services:
```bash
docker-compose up -d
```

This will start:
- Frontend (Next.js) on http://localhost:3000
- Backend API on http://localhost:3001
- PostgreSQL database on port 5432

3. To stop all services:
```bash
docker-compose down
```

## Development Setup

### Local Development

1. Install dependencies:
```bash
pnpm install
```

2. Set up environment variables:
```bash
# Copy example env files
cp apps/frontend/.env.example apps/frontend/.env
cp apps/backend/.env.example apps/backend/.env
```

3. Start the development servers:
```bash
# Start all services
pnpm dev

# Or start specific services
pnpm dev --filter frontend
pnpm dev --filter backend
```

### Database Management

The project uses PostgreSQL with the following default credentials:
- Database: gaza_name_project_db
- User: gaza_name_user
- Password: your_secure_password
- Port: 5432

To connect to the database:
```bash
# Using Docker
docker exec -it gaza-name-project-db-1 psql -U gaza_name_user -d gaza_name_project_db

# Using local PostgreSQL
psql -U gaza_name_user -d gaza_name_project_db
```

## Deployment Options

### Option 1: Cloud Deployment (Recommended)

1. **AWS Setup**:
   - Use AWS ECS for container orchestration
   - RDS for PostgreSQL
   - S3 for audio file storage
   - CloudFront for CDN
   - Route 53 for DNS

2. **Google Cloud Platform**:
   - Google Kubernetes Engine (GKE)
   - Cloud SQL for PostgreSQL
   - Cloud Storage for audio files
   - Cloud CDN

3. **DigitalOcean**:
   - App Platform for container deployment
   - Managed Databases for PostgreSQL
   - Spaces for object storage

### Option 2: Self-Hosting on Mac Mini

1. **Prerequisites**:
   - Mac Mini with macOS
   - Docker Desktop for Mac
   - Static IP or domain name
   - SSL certificate (Let's Encrypt)

2. **Setup Steps**:
   ```bash
   # Install Docker Desktop
   brew install --cask docker

   # Clone and run the project
   git clone [repository-url]
   cd gaza-name-project
   docker-compose up -d
   ```

3. **Production Considerations**:
   - Use a reverse proxy (Nginx/Traefik)
   - Set up SSL with Let's Encrypt
   - Configure automatic updates
   - Set up monitoring (Prometheus/Grafana)
   - Regular backups of PostgreSQL data

## Project Structure

```
gaza-name-project/
├── apps/
│   ├── frontend/     # Next.js frontend application
│   └── backend/      # Node.js API server
├── packages/
│   └── shared/       # Shared TypeScript types and utilities
├── docker/
│   ├── frontend/     # Frontend Dockerfile
│   └── backend/      # Backend Dockerfile
└── docker-compose.yml
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

[Your License Here]

## Support

For support, please [create an issue](repository-issues-url) in the repository.
