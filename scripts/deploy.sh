#!/bin/bash
set -e
git pull origin main
docker compose build --no-cache backend frontend
docker compose up -d
docker compose ps
echo "Deploy completato"
