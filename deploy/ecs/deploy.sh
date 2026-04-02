#!/usr/bin/env bash
# deploy/ecs/deploy.sh — Deploy pilotswarm-worker to AWS Fargate
#
# Prerequisites:
#   - AWS CLI configured (aws configure)
#   - Docker image pushed to ECR (npm run docker:push)
#   - Neon DATABASE_URL ready
#   - .env file with all required vars
#
# Usage:
#   bash deploy/ecs/deploy.sh
#
# What this does:
#   1. Creates IAM roles (ecsTaskExecutionRole, pilotswarm-task-role)
#   2. Stores secrets in SSM Parameter Store
#   3. Creates CloudWatch log group
#   4. Creates ECS cluster
#   5. Registers task definition
#   6. Creates ECS service (1 Fargate task)

set -euo pipefail

REGION="us-east-1"
ACCOUNT_ID="794267021535"
CLUSTER_NAME="pilotswarm"
SERVICE_NAME="pilotswarm-worker"
TASK_FAMILY="pilotswarm-worker"
ECR_IMAGE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/pilotswarm-worker:latest"

# Load .env for secret values
if [ ! -f .env ]; then
    echo "ERROR: .env file not found. Run from project root."
    exit 1
fi
source .env

echo ""
echo "=== PilotSwarm Fargate Deployment ==="
echo "  Region  : $REGION"
echo "  Account : $ACCOUNT_ID"
echo "  Cluster : $CLUSTER_NAME"
echo "  Image   : $ECR_IMAGE"
echo ""

# ── Step 1: IAM — ecsTaskExecutionRole ───────────────────────────────────────
echo "[1/6] Ensuring ecsTaskExecutionRole exists..."
aws iam create-role \
    --role-name ecsTaskExecutionRole \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --region $REGION 2>/dev/null || echo "  (already exists)"

aws iam attach-role-policy \
    --role-name ecsTaskExecutionRole \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy \
    2>/dev/null || echo "  (policy already attached)"

# Allow task execution role to read SSM parameters
aws iam attach-role-policy \
    --role-name ecsTaskExecutionRole \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess \
    2>/dev/null || echo "  (SSM policy already attached)"

echo "  done."

# ── Step 2: IAM — pilotswarm-task-role (S3 access) ───────────────────────────
echo "[2/6] Ensuring pilotswarm-task-role exists..."
aws iam create-role \
    --role-name pilotswarm-task-role \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --region $REGION 2>/dev/null || echo "  (already exists)"

aws iam attach-role-policy \
    --role-name pilotswarm-task-role \
    --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess \
    2>/dev/null || echo "  (policy already attached)"

echo "  done."

# ── Step 3: SSM Parameter Store — store secrets ───────────────────────────────
echo "[3/6] Storing secrets in SSM Parameter Store..."

store_param() {
    local name=$1
    local value=$2
    aws ssm put-parameter \
        --name "/pilotswarm/${name}" \
        --value "$value" \
        --type SecureString \
        --overwrite \
        --region $REGION > /dev/null
    echo "  stored: /pilotswarm/${name}"
}

store_param "DATABASE_URL"          "${DATABASE_URL}"
store_param "GITHUB_TOKEN"          "${GITHUB_TOKEN:-}"
store_param "AWS_S3_BUCKET"         "${AWS_S3_BUCKET}"
store_param "AWS_ACCESS_KEY_ID"     "${AWS_ACCESS_KEY_ID}"
store_param "AWS_SECRET_ACCESS_KEY" "${AWS_SECRET_ACCESS_KEY}"

echo "  done."

# ── Step 4: CloudWatch log group ──────────────────────────────────────────────
echo "[4/6] Creating CloudWatch log group..."
aws logs create-log-group \
    --log-group-name /ecs/pilotswarm-worker \
    --region $REGION 2>/dev/null || echo "  (already exists)"
echo "  done."

# ── Step 5: ECS cluster ───────────────────────────────────────────────────────
echo "[5/6] Creating ECS cluster..."
aws ecs create-cluster \
    --cluster-name $CLUSTER_NAME \
    --capacity-providers FARGATE FARGATE_SPOT \
    --region $REGION > /dev/null 2>&1 || echo "  (already exists)"
echo "  done."

# ── Step 6: Register task definition + create service ────────────────────────
echo "[6/6] Registering task definition and creating service..."

aws ecs register-task-definition \
    --cli-input-json file://deploy/ecs/task-definition.json \
    --region $REGION > /dev/null

# Get default VPC and subnets
VPC_ID=$(aws ec2 describe-vpcs \
    --filters "Name=isDefault,Values=true" \
    --query "Vpcs[0].VpcId" \
    --output text \
    --region $REGION)

SUBNET_IDS=$(aws ec2 describe-subnets \
    --filters "Name=vpc-id,Values=${VPC_ID}" \
    --query "Subnets[*].SubnetId" \
    --output text \
    --region $REGION | tr '\t' ',')

# Security group: allow all outbound, no inbound (worker only polls DB)
SG_ID=$(aws ec2 create-security-group \
    --group-name pilotswarm-worker-sg \
    --description "PilotSwarm worker — outbound only" \
    --vpc-id $VPC_ID \
    --region $REGION \
    --query "GroupId" \
    --output text 2>/dev/null) || \
    SG_ID=$(aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=pilotswarm-worker-sg" \
        --query "SecurityGroups[0].GroupId" \
        --output text \
        --region $REGION)

# Create or update ECS service
aws ecs create-service \
    --cluster $CLUSTER_NAME \
    --service-name $SERVICE_NAME \
    --task-definition $TASK_FAMILY \
    --desired-count 1 \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_IDS}],securityGroups=[${SG_ID}],assignPublicIp=ENABLED}" \
    --region $REGION > /dev/null 2>/dev/null || \
aws ecs update-service \
    --cluster $CLUSTER_NAME \
    --service $SERVICE_NAME \
    --task-definition $TASK_FAMILY \
    --desired-count 1 \
    --region $REGION > /dev/null

echo "  done."
echo ""
echo "=== Deployment complete ==="
echo ""
echo "Monitor your worker:"
echo "  aws ecs describe-services --cluster $CLUSTER_NAME --services $SERVICE_NAME --region $REGION"
echo "  aws logs tail /ecs/pilotswarm-worker --follow --region $REGION"
echo ""
