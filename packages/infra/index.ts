import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const env = config.get("env");
const albName = config.get("alb");
const clusterName = config.get("cluster") || "ig-dev-3631767";
const listenerArn = config.get("enlistenerv");
const certArn = config.get("cert");
const url = config.get("url");
const rulePriority = +(
    config.get("rulePriority") || Math.floor(Math.random() * 200) + 1
);

// Get common infra

const vpc = aws.ec2.getVpcOutput({ id: "vpc-05fe1cfe39cb385ed" });
const alb = aws.lb.getLoadBalancerOutput({ name: albName });
const cluster = aws.ecs.getClusterOutput({ clusterName: clusterName });
const listener443 = aws.lb.getListenerOutput({
    arn: listenerArn,
    loadBalancerArn: alb.arn,
    port: 443,
});

// Set up secrets

const secrets = [
    "SANITY_WEBHOOK_SECRET",
    "SANITY_PREVIEW_TOKEN",
    "API_KEY_ALGOLIA_ROUTES",
    "AUTH0_AUDIENCE",
    "AUTH0_ISSUER_BASE_URL",
    "AUTH0_SECRET",
    "AUTH0_CLIENT_ID",
    "AUTH0_CLIENT_SECRET",
    "ALGOLIA_ROUTES_API_KEY",
    "ALGOLIA_WRITE_API_KEY",
    "POWERBI_CLIENT_ID",
    "POWERBI_CLIENT_SECRET",
    "POWERBI_TENANT",
];

const secObj: awsx.types.input.ecs.TaskDefinitionSecretArgs[] = [];

secrets.forEach((secret) => {
    const sec = new aws.ssm.Parameter(`pulumi-test-${env}-${secret}`, {
        type: "SecureString",
        value: config.getSecret(secret),
    });

    secObj.push({
        name: secret,
        valueFrom: sec.arn,
    });
});

// ## SITE ## //

const pulumitestHZ = new aws.route53.Zone(
    `pulumitest-${env}-zone`,
    { name: url },
    { protect: true }
);

// Create DNS record in the hosted zone
const albARecord = new aws.route53.Record(
    `${env}-a-pulumitest`,
    {
        zoneId: pulumitestHZ.zoneId,
        name: "",
        type: "A",
        aliases: [
            {
                evaluateTargetHealth: true,
                name: alb.dnsName,
                zoneId: alb.zoneId,
            },
        ],
    },
    { protect: true }
);

// Create ECR Repo for docker image
const pulumitestRepo = new aws.ecr.Repository(
    `pulumitest-web-${env}`,
    {
        tags: {
            Client: "pulumitest",
            Name: `pulumitest ${env} Web Repo`,
        },
    },
    { protect: true }
);

const pulumitestImageWebDev = new awsx.ecr.Image(
    `pulumitest-web-${env}-image`,
    {
        repositoryUrl: pulumitestRepo.repositoryUrl,
        dockerfile: `../../.docker/next.Dockerfile`,
        path: "../../",
        args: {
            WORKSPACE: "web",
            NODE_ENV: "production",
            PORT: "3000",
            NEXT_PUBLIC_SANITY_PROJECT_ID:
                env === "production" ? "xjetorgi" : "s9egr9mn",
            NEXT_PUBLIC_SANITY_API_VERSION: "2023-06-01",
            NEXT_PUBLIC_SANITY_DATASET: "production",
            NEXT_PUBLIC_API_URL: `https://${url}/api`,
            NEXT_PUBLIC_BASE_URL: `https://${url}`,
            NEXT_PUBLIC_PORT: "3000",
            NEXT_PUBLIC_NODE_ENV: "production",
            NEXT_PUBLIC_SANITY_STUDIO_TITLE: "pulumitest",
            NEXT_PUBLIC_ALGOLIA_INDEX:
                env === "production" ? "prod_contentHub" : "Test_pulumitest",
            NEXT_PUBLIC_ALGOLIA_SEARCH_ONLY_KEY:
                env === "production"
                    ? "f4dafff8d6d54fcc764cd6ffcc334dca"
                    : "af30881c89beeff19f2537b70d84ffcf",
            NEXT_PUBLIC_ALGOLIA_APPLICATION_ID:
                env === "production" ? "ABRJ5NEDAZ" : "WX23VFIASO",
            NEXT_PUBLIC_SECURE_UPLOADS_URL:
                env === "production"
                    ? "https://aiq-cdn.pulumitest.com"
                    : "https://pulumitest-cdn.staging.intergalactic.space",
        },
    },
    { protect: true }
);

const pulumitestTargetGroup = new aws.lb.TargetGroup(
    `pulumitest-${env}-tg`,
    {
        port: 80,
        protocol: "HTTP",
        targetType: "instance",
        vpcId: vpc.id,
        healthCheck: {
            path: "/api/healthz",
            matcher: "200",
        },
        tags: {
            Client: "pulumitest",
            Name: `pulumitest Web ${env} Target Group`,
        },
    },
    { protect: true }
);

if (certArn) {
    const pulumitestListenerCert = new aws.alb.ListenerCertificate(
        `pulumitest-${env}-cert`,
        {
            listenerArn: listener443.arn,
            certificateArn: certArn,
        }
    );
} else {
    console.log("No cert found");
}

const pulumitestRule = new aws.lb.ListenerRule(
    `pulumitest-${env}-rule`,
    {
        actions: [
            {
                type: "forward",
                targetGroupArn: pulumitestTargetGroup.arn,
            },
        ],
        conditions: [
            {
                hostHeader: {
                    values: [`pulumitest.${env}.intergalactic.space`],
                },
            },
        ],
        listenerArn: listener443.arn,
        priority: rulePriority,
        tags: {
            Client: "pulumitest",
            Name: `pulumitest Web ${env} Rule`,
        },
    },
    { protect: true }
);

// Create an ECS task definition for EC2 launch type
const pulumitestTaskDefinition = new awsx.ecs.EC2TaskDefinition(
    `pulumitest-web-${env}`,
    {
        containers: {
            app: {
                name: "app",
                image: pulumitestImageWebDev.imageUri,
                cpu: 0,
                portMappings: [
                    {
                        containerPort: 3000,
                        hostPort: 0,
                        protocol: "tcp",
                    },
                ],
                essential: true,
                environment: [
                    {
                        name: "NEXT_PUBLIC_BASE_URL",
                        value: `https://${url}`,
                    },
                    {
                        name: "NEXT_PUBLIC_SANITY_PROJECT_ID",
                        value: env === "production" ? "xjetorgi" : "s9egr9mn",
                    },
                    {
                        name: "NEXT_PUBLIC_SANITY_API_VERSION",
                        value: "2023-06-01",
                    },
                    {
                        name: "NEXT_PUBLIC_PORT",
                        value: "3000",
                    },
                    {
                        name: "AUTH0_BASE_URL",
                        value: `https://${url}`,
                    },
                    // {
                    //   name: "AUTH0_ISSUER_BASE_URL",
                    //   value:
                    //     env === "production"
                    //       ? "https://dev-pulumitest.uk.auth0.com"
                    //       : "https://pulumitest-content-hub.uk.auth0.com",
                    // },
                    // {
                    //   name: "AUTH0_AUDIENCE",
                    //   value:
                    //     env === "production"
                    //       ? "content-hub-api"
                    //       : "pulumitest-content-hub-api",
                    // },
                    {
                        name: "NEXT_PUBLIC_NODE_ENV",
                        value: "production",
                    },
                    {
                        name: "NEXT_PUBLIC_ALGOLIA_INDEX",
                        value: env === "production" ? "prod_contentHub" : "Test_pulumitest",
                    },
                    {
                        name: "NEXT_PUBLIC_ALGOLIA_APPLICATION_ID",
                        value: env === "production" ? "ABRJ5NEDAZ" : "WX23VFIASO",
                    },
                    {
                        name: "NEXT_PUBLIC_ALGOLIA_SEARCH_ONLY_KEY",
                        value:
                            env === "production"
                                ? "f4dafff8d6d54fcc764cd6ffcc334dca"
                                : "af30881c89beeff19f2537b70d84ffcf",
                    },
                    {
                        name: "NEXT_PUBLIC_SECURE_UPLOADS_URL",
                        value:
                            env === "production"
                                ? "https://aiq-cdn.pulumitest.com"
                                : "https://pulumitest-cdn.staging.intergalactic.space",
                    },
                ],
                mountPoints: [],
                volumesFrom: [],
                secrets: secObj,
                logConfiguration: {
                    logDriver: "awslogs",
                    options: {
                        "awslogs-create-group": "true",
                        "awslogs-group": `/ecs/pulumitest-web-${env}`,
                        "awslogs-region": "us-west-2",
                        "awslogs-stream-prefix": "ecs",
                    },
                },
            },
        },
        taskRole: {
            roleArn: "arn:aws:iam::917877734628:role/ecsTaskExecutionRole",
        },
        executionRole: {
            roleArn: "arn:aws:iam::917877734628:role/ecsTaskExecutionRole",
        },
        family: `pulumitest-${env}`,
        networkMode: "bridge",
        runtimePlatform: {
            cpuArchitecture: "ARM64",
            operatingSystemFamily: "LINUX",
        },
        cpu: "128",
        memory: "256",
        tags: {
            Client: "pulumitest",
            Name: `pulumitest Web ${env} Task`,
        },
    }
);

// Create an ECS service, running on the previously created cluster
const pulumitestService = new awsx.ecs.EC2Service(`pulumitest-web-${env}`, {
    cluster: cluster.arn,
    taskDefinition: pulumitestTaskDefinition.taskDefinition.family,
    propagateTags: "TASK_DEFINITION",
    desiredCount: 1,
    enableEcsManagedTags: true,
    continueBeforeSteadyState: true,
    deploymentCircuitBreaker: {
        enable: true,
        rollback: true,
    },
    loadBalancers: [
        {
            targetGroupArn: pulumitestTargetGroup.arn,
            containerName: "app",
            containerPort: 3000,
        },
    ],
});

// Setting up Amazon Simple Email Service for prod env
let smtpUsername;

if (env === "production") {
    const pulumitestSesDomain = new aws.ses.DomainIdentity(
        "pulumitestSes",
        {
            domain: "intergalactic.com",
        },
        { protect: true }
    );
    const pulumitestSesAmazonsesVerificationRecord = new aws.route53.Record(
        "pulumitestSesAmazonsesVerificationRecord",
        {
            zoneId: "Z01707952S9R61QRTSNP0",
            name: pulumi.interpolate`_amazonses.${pulumitestSesDomain.id}`,
            type: "TXT",
            ttl: 600,
            records: [pulumitestSesDomain.verificationToken],
        },
        { protect: true }
    );
    const pulumitestSesVerification = new aws.ses.DomainIdentityVerification(
        "pulumitestSesVerification",
        { domain: pulumitestSesDomain.id },
        {
            dependsOn: [pulumitestSesAmazonsesVerificationRecord],
            protect: true,
        }
    );

    const sesEmail = new aws.ses.EmailIdentity(
        `pulumitest-${env}-ses-email`,
        {
            email: "dev+pulumitest@intergalactic.com",
        },
        { protect: true }
    );

    const sesDomain = new aws.ses.DomainIdentity(
        `pulumitest-${env}-ses-doamin`,
        {
            domain: "intergalactic.com",
        },
        { protect: true }
    );

    // Create an IAM policy
    const smtpAccessPolicy = new aws.iam.Policy(
        "ses-smtp-policy",
        {
            policy: JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: "Allow",
                        Action: ["ses:SendRawEmail", "ses:SendEmail"],
                        Resource: "*",
                    },
                ],
            }),
            tags: {
                Client: "pulumitest",
                Name: `pulumitest Web ${env} STMP Policy`,
            },
        },
        { protect: true }
    );

    // Create an IAM user for SES SMTP access
    const smtpAccessUser = new aws.iam.User(
        "ses-smtp-user",
        {
            forceDestroy: true,
            tags: {
                Client: "pulumitest",
                Name: `pulumitest Web ${env} STMP Access User`,
            },
        },
        { protect: true }
    );

    // Attach the policy to the IAM user
    const smtpAccessPolicyAttachment = new aws.iam.PolicyAttachment(
        "ses-smtp-policy-attachment",
        {
            users: [smtpAccessUser.name],
            policyArn: smtpAccessPolicy.arn,
        },
        { protect: true }
    );

    // Generate the IAM access keys for the IAM user
    const smtpAccessKeys = new aws.iam.AccessKey(
        "ses-smtp-access-keys",
        {
            user: smtpAccessUser.name,
        },
        { protect: true }
    );

    // Create a new parameter in AWS System Manager Parameter Store
    const param = new aws.ssm.Parameter("pulumitest-stmp-password", {
        type: "SecureString",
        value: smtpAccessKeys.sesSmtpPasswordV4,
        tags: {
            Client: "pulumitest",
            Name: `pulumitest Web ${env} STMP Access User Password`,
        },
    });

    // Export the SMTP username and password
    smtpUsername = smtpAccessKeys.id;
}

export { smtpUsername };
