import {BrazilPackage, DeploymentStack, DeploymentStackProps, LambdaAsset} from "@amzn/pipelines";
import * as cdk from "monocdk";
import {App, CfnMapping, Construct, Duration, Fn} from "monocdk";
import * as lambda from "monocdk/aws-lambda";
import {IFunction} from "monocdk/aws-lambda";
import * as log from 'monocdk/aws-logs';
import {LogGroup, RetentionDays} from 'monocdk/aws-logs';
import {ArnPrincipal, AccountPrincipal, Effect, ManagedPolicy, PolicyStatement, Role, ServicePrincipal} from "monocdk/aws-iam";
import {SubnetType} from '@aws-cdk/aws-ec2';
import {
    AccessLogFormat,
    AuthorizationType,
    LambdaIntegration,
    LambdaRestApi,
    LogGroupLogDestination,
    MethodLoggingLevel,
    Model,
    PassthroughBehavior,
    RequestValidator
} from "monocdk/aws-apigateway";
import {snsTopicName, topicName, urlStatusSubscription} from "../constants/sns";
import {SecureCloudAuth} from "@amzn/mote-constructs-cloudauth";
import {DomainValidation} from "../constants/pipeline";
import {
    httpMethods,
    integrationResponse,
    requestSchemas,
    responseSchemas,
    StatusCodes,
    requestParams,
    resources
} from "../constants/apigw";
import * as jsonSchema from "monocdk/lib/aws-apigateway/lib/json-schema";
import {
    caseIDAttributeName,
    caseIdIndexName,
    clientReferenceGroupIdAttributeName,
    defaultCapacity,
    defaultScaleOnLimit,
    URLAttributeName,
    DomainValidationTableName,
    investigationIdAttributeName,
    subInvestigationTypeAttributeName,
    clientRefGroupId_UrlAttributeName,
    clientRefGroupId_UrlIndexName,
    UrlInvestigationTableName,
    subInvestigationIdIndexName,
    subInvestigationIdAttributeName,
    reviewStartTimeAttributeName,
    clientRefGroupId_NormalizedUrlIndexName,
    normalizedUrlAttributeName
} from "../constants/ddb";
import {
    functionAndQueueMap,
    functionAndQueueMapSetup,
    errorSuffix,
    getQueueUrl,
    mainQueueSuffix,
    vendorResponseValidationErrorQueueUrl,
    queueAndAccountRoleArnMap,
    queueAndAccountRoleArnMapSetup,
    executeVendorResponseWorkflowErrorQueueUrl,
    executeUrlReviewWorkflowDlqUrl,
    getErrorQueueName
} from "../constants/sqs";
import {
    dlqPollerName,
    dlqPollersName,
    functionNames,
    getHandler,
    upfrontURLValidation,
    executeVendorResponseWorkflow,
    processManualResponse,
    initiateManualReview,
    processVendorResponse,
    initiateVendorReview,
    executeUrlReviewWorkflow,
    getLatestVendorReviewResponse,
    triggerURLReview,
    executeManualResponseWorkflow,
    processInvestigationResponse,
    errorQueuePollerName
} from "../constants/lambda";
import {dlqName, dlqProps, dlqPropsSetup, dlqSuffix} from "../constants/dlq";
import {Queue} from "monocdk/aws-sqs";
import {SqsEventSource} from "monocdk/aws-lambda-event-sources";
import {HydraTestRunResources} from '@amzn/hydra';
import {testPackage, testRunResourceGroupName} from "../constants/hydra";
import {IHydraEnvironment} from "@amzn/builder-tools-scaffolding";
import {DomainValidationAlarms, Sev2DomainValidationAlarms} from "../alarms/setupAlarms";
import {Subscription, SubscriptionProtocol, Topic} from "monocdk/aws-sns";
import dynamodb = require('monocdk/aws-dynamodb');
import moteec2 = require('@amzn/motecdk/mote-ec2');
import {fetchCfnMapping, merchantURLStatusQueueMappingKey} from "../constants/mapping";
import { createStepFunction } from "../util/url-review-workflow";
import { getWorkflowTypes, urlReviewWorkflowName } from "../constants/step-function";
import {Bucket} from "monocdk/aws-s3";
import {
    getBucketName,
    s3AndAccountRoleArnMap,
    s3AndAccountRoleArnMapSetup,
    vendorResponseBucketName,
    evercBackfillBucketName
} from "../constants/s3";
import * as secretsmanager from "monocdk/aws-secretsmanager";

export interface DomainValidationStackProps extends cdk.StackProps {
    readonly vpc: moteec2.SecureVpc,
    readonly cloudauth: SecureCloudAuth,
    readonly realm: string,
    readonly pipelineStageName: string,
    readonly accountId: string,
    readonly stage: string,
    readonly region: string,
    readonly localResourceNameSuffix: string,
    readonly domain: string,
    cfnMapping?: CfnMapping
}

export interface LambdaMetadata {
    readonly lambdaFunc: lambda.Function,
    readonly dlq?: Queue,
}

export class DomainValidationStack extends DeploymentStack {

    public readonly hydraResources: HydraTestRunResources;
    public readonly stackAlarms: DomainValidationAlarms;
    public readonly sev2StackAlarms: Sev2DomainValidationAlarms;

    constructor(scope: App, idPrefix: string, props: DeploymentStackProps, domainValidationStackProps: DomainValidationStackProps) {
        let id = idPrefix + "-stack"
        super(scope, id, props);

        dlqPropsSetup(domainValidationStackProps.localResourceNameSuffix);
        functionAndQueueMapSetup(domainValidationStackProps.localResourceNameSuffix);
        queueAndAccountRoleArnMapSetup(domainValidationStackProps.localResourceNameSuffix, domainValidationStackProps.pipelineStageName);
        s3AndAccountRoleArnMapSetup(domainValidationStackProps.localResourceNameSuffix, domainValidationStackProps.stage, domainValidationStackProps.pipelineStageName);
        domainValidationStackProps.cfnMapping = fetchCfnMapping(this);

        let ddbDomainValidationTable = this.createDomainValidationTable(DomainValidationTableName
            + domainValidationStackProps.localResourceNameSuffix);

        let ddbUrlInvestigationTable = this.createUrlInvestigationTable(UrlInvestigationTableName
            + domainValidationStackProps.localResourceNameSuffix);

        let merchantUrlStatusTopic = new Topic(this, topicName, {
            displayName: snsTopicName(domainValidationStackProps.stage, domainValidationStackProps.region)
        });
        DomainValidationStack.addSubscribtionToTopic(this, merchantUrlStatusTopic, props, domainValidationStackProps);
        DomainValidationStack.createSNSPolicyRole(merchantUrlStatusTopic, domainValidationStackProps.accountId);

        let lambdaRole = this.createLambdaInvocationRole(domainValidationStackProps);
        let getLatestVendorReviewResponseLambdaRole = this.createLambdaInvocationRoleForGetLatestVendorReviewResponse(domainValidationStackProps, getLatestVendorReviewResponse);
        let lambdaFunctions = this.createLambdas(DomainValidationStack.resourceNames(functionNames,
            domainValidationStackProps.localResourceNameSuffix), lambdaRole,
            domainValidationStackProps, merchantUrlStatusTopic.topicArn);
        let pollerFunctions = this.createLambdas(DomainValidationStack.resourceNames(dlqPollersName(functionNames),
            domainValidationStackProps.localResourceNameSuffix), lambdaRole,
            domainValidationStackProps, '');
        let executeUrlReviewWorkflowFunctionDlq = this.createLambdaDLQ(DomainValidationStack.resourceName(executeUrlReviewWorkflow,
            domainValidationStackProps.localResourceNameSuffix));
        let executeUrlReviewWorkflowFunction = this.createLambda(DomainValidationStack.resourceName(executeUrlReviewWorkflow,
            domainValidationStackProps.localResourceNameSuffix), lambdaRole,
            domainValidationStackProps, merchantUrlStatusTopic.topicArn, executeUrlReviewWorkflowFunctionDlq);
        let executeVendorResponseWorkflowFunction = this.createLambda(DomainValidationStack.resourceName(executeVendorResponseWorkflow,
            domainValidationStackProps.localResourceNameSuffix), lambdaRole,
            domainValidationStackProps, '');
        let executeManualResponseWorkflowFunctionDlq = this.createLambdaDLQ(DomainValidationStack.resourceName(executeManualResponseWorkflow,
            domainValidationStackProps.localResourceNameSuffix));
        let executeManualResponseWorkflowFunction = this.createLambda(DomainValidationStack.resourceName(executeManualResponseWorkflow,
            domainValidationStackProps.localResourceNameSuffix), lambdaRole,
            domainValidationStackProps, '', executeManualResponseWorkflowFunctionDlq);
        let executeManualResponseWorkflowDLQPollerFunction = this.createLambda(DomainValidationStack.resourceName(dlqPollerName(executeManualResponseWorkflow),
            domainValidationStackProps.localResourceNameSuffix), lambdaRole, domainValidationStackProps, '');
        let executeUrlReviewWorkflowDLQPollerFunction = this.createLambda(DomainValidationStack.resourceName(dlqPollerName(executeUrlReviewWorkflow),
            domainValidationStackProps.localResourceNameSuffix), lambdaRole, domainValidationStackProps, '');
        let upfrontURLValidationFunction = this.createLambda(DomainValidationStack.resourceName(upfrontURLValidation,
            domainValidationStackProps.localResourceNameSuffix), lambdaRole, domainValidationStackProps, '');
        let initiateVendorReviewFunction = this.createLambda(DomainValidationStack.resourceName(initiateVendorReview,
            domainValidationStackProps.localResourceNameSuffix), lambdaRole, domainValidationStackProps, '');
        let processVendorResponseFunction = this.createLambda(DomainValidationStack.resourceName(processVendorResponse,
            domainValidationStackProps.localResourceNameSuffix), lambdaRole, domainValidationStackProps, '');
        let initiateManualReviewFunction = this.createLambda(DomainValidationStack.resourceName(initiateManualReview,
            domainValidationStackProps.localResourceNameSuffix), lambdaRole, domainValidationStackProps, '');
        let processManualResponseFunction = this.createLambda(DomainValidationStack.resourceName(processManualResponse,
            domainValidationStackProps.localResourceNameSuffix), lambdaRole, domainValidationStackProps, '');

        let getLatestVendorReviewResponseFunction = this.createLambda(DomainValidationStack.resourceName(getLatestVendorReviewResponse,
            domainValidationStackProps.localResourceNameSuffix), getLatestVendorReviewResponseLambdaRole, domainValidationStackProps, '');
        let executeVendorResponseWorkflowErrorQueuePollerFunction = this.createLambda(DomainValidationStack.resourceName(errorQueuePollerName(executeVendorResponseWorkflow),
            domainValidationStackProps.localResourceNameSuffix), lambdaRole, domainValidationStackProps, '');

        let lambdafunctionsForAPIGateway: Map<string, LambdaMetadata> = new Map<string, LambdaMetadata>();

        for (let [funcName, funcMeta] of lambdaFunctions) {
            // TODO: Temporary check for NA to point triggerUrlReview API to executeUrlReviewWorkflow lambda,
            // Later on this check can be removed and triggerUrlReview API can point to executeUrlReviewWorkflow handler.
            let funcNameMapping = DomainValidationStack.resourceNamesplit(funcName, '-', 0);
            if (domainValidationStackProps.realm === 'USAmazon' && funcNameMapping === triggerURLReview) {
                funcMeta = {
                    lambdaFunc: executeUrlReviewWorkflowFunction,
                    dlq: executeUrlReviewWorkflowFunctionDlq
                }
            }

            if (domainValidationStackProps.realm === 'USAmazon' && funcNameMapping === processInvestigationResponse) {
                funcMeta = {
                    lambdaFunc: executeManualResponseWorkflowFunction,
                    dlq: executeManualResponseWorkflowFunctionDlq
                }
            }
            lambdafunctionsForAPIGateway.set(funcName, {
                lambdaFunc : funcMeta.lambdaFunc,
                dlq: funcMeta.dlq
            })
        }

        lambdafunctionsForAPIGateway.set(DomainValidationStack.resourceName(
            getLatestVendorReviewResponse, domainValidationStackProps.localResourceNameSuffix), {
            lambdaFunc : getLatestVendorReviewResponseFunction
        })

        //ToDo: Split it , make it modular and also move it other file.
        // SIM: https://sim.amazon.com/issues/D27201069
        this.createAPIGateway(idPrefix, lambdafunctionsForAPIGateway, domainValidationStackProps.localResourceNameSuffix);
        this.createSQS(DomainValidationStack.resourceName(executeVendorResponseWorkflow,
            domainValidationStackProps.localResourceNameSuffix), executeVendorResponseWorkflowFunction, domainValidationStackProps);
        this.createS3(getBucketName(vendorResponseBucketName, domainValidationStackProps.stage,
            domainValidationStackProps.localResourceNameSuffix), domainValidationStackProps.stage);
        this.createS3(getBucketName(evercBackfillBucketName, domainValidationStackProps.stage,
            domainValidationStackProps.localResourceNameSuffix), domainValidationStackProps.stage);

        // Create Url Review Step Functions
        getWorkflowTypes(domainValidationStackProps.realm).forEach( (workflowType) => {
            let workflowName = urlReviewWorkflowName + "_" + workflowType.type
            let urlReviewWorkflowProps = {
                workflowName: DomainValidationStack.resourceName(workflowName, domainValidationStackProps.localResourceNameSuffix),
                workflowType: workflowType.type,
                upfrontValidation: workflowType.upfrontValidation,
                vendorReview: workflowType.vendorReview,
                manualReview: workflowType.manualReview,
                autoLightWeight: workflowType.autoLightWeight,
                upfrontUrlValidationLambda: upfrontURLValidationFunction,
                initiateVendorReviewLambda: initiateVendorReviewFunction,
                processVendorResponseLambda: processVendorResponseFunction,
                initiateManualReviewLambda: initiateManualReviewFunction,
                processManualResponseLambda: processManualResponseFunction,
                domainDDB: ddbDomainValidationTable,
                urlInvestigationDDB: ddbUrlInvestigationTable,
                snsTopic: merchantUrlStatusTopic,
            };
            let urlReviewWorkflow = createStepFunction(this, urlReviewWorkflowProps);
            executeUrlReviewWorkflowFunction.addEnvironment(workflowName, urlReviewWorkflow.stateMachineArn);
            executeVendorResponseWorkflowFunction.addEnvironment(workflowName, urlReviewWorkflow.stateMachineArn);
            executeManualResponseWorkflowFunction.addEnvironment(workflowName, urlReviewWorkflow.stateMachineArn);
            executeVendorResponseWorkflowErrorQueuePollerFunction.addEnvironment(workflowName, urlReviewWorkflow.stateMachineArn);
        })

        let executeVendorResponseWorkflowFunctionErrorQueue = this.createErrorQueueForLambda(DomainValidationStack.resourceName(executeVendorResponseWorkflow,
            domainValidationStackProps.localResourceNameSuffix), domainValidationStackProps);
        let executeVendorResponseWorkflowFunctionErrorQueueUrl = getQueueUrl(domainValidationStackProps.region,
            domainValidationStackProps.accountId,
            getErrorQueueName(DomainValidationStack.resourceName(executeVendorResponseWorkflow,
                domainValidationStackProps.localResourceNameSuffix)));
        executeVendorResponseWorkflowFunction.addEnvironment(executeVendorResponseWorkflowErrorQueueUrl, executeVendorResponseWorkflowFunctionErrorQueueUrl);

        executeVendorResponseWorkflowErrorQueuePollerFunction.addEnvironment(executeVendorResponseWorkflowErrorQueueUrl, executeVendorResponseWorkflowFunctionErrorQueueUrl);
        executeVendorResponseWorkflowErrorQueuePollerFunction.addEventSource(new SqsEventSource(executeVendorResponseWorkflowFunctionErrorQueue, {
            batchSize: 1,
        }));

        let executeUrlReviewWorkflowFunctionDlqUrl = getQueueUrl(domainValidationStackProps.region, domainValidationStackProps.accountId,
            dlqName(executeUrlReviewWorkflow + domainValidationStackProps.localResourceNameSuffix));
        executeUrlReviewWorkflowFunction.addEnvironment(executeUrlReviewWorkflowDlqUrl, executeUrlReviewWorkflowFunctionDlqUrl);

        /*
         * Generating Hydra Resources for Beta and Gamma only,
         * as we are not adding Integration Approval in Prod.
        */
        if (domainValidationStackProps.pipelineStageName != 'Prod') {
            this.hydraResources = this.createHydraTestRunResources(testRunResourceGroupName, props.env.hydraEnvironment);
            this.hydraResources.invocationRole.addToPolicy(
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["execute-api:Invoke", "lambda:InvokeFunction"],
                    resources: ["*"]
                })
            );
        }

        for (let [funcName, funcMeta] of lambdaFunctions) {
            ddbDomainValidationTable.grantReadWriteData(funcMeta.lambdaFunc);
            ddbUrlInvestigationTable.grantReadWriteData(funcMeta.lambdaFunc);

            let funcNameMapping = DomainValidationStack.resourceNamesplit(funcName, '-', 0);
            let pollerFunc = pollerFunctions.get(dlqPollerName(funcNameMapping)
                + domainValidationStackProps.localResourceNameSuffix)!.lambdaFunc;
            let dlq = funcMeta.dlq;
            pollerFunc.addEventSource(new SqsEventSource(dlq!, {
                batchSize: 1,
                //TODO batchWindow. Ref - https://github.com/aws/aws-cdk/issues/11722
            }));
        }

        executeManualResponseWorkflowDLQPollerFunction.addEventSource(new SqsEventSource(executeManualResponseWorkflowFunctionDlq, {
            batchSize: 1,
        }));

        executeUrlReviewWorkflowDLQPollerFunction.addEventSource(new SqsEventSource(executeUrlReviewWorkflowFunctionDlq, {
            batchSize: 1,
        }));

        if (domainValidationStackProps.stage.startsWith("prod")) {
            /**
             * Step up domain validation stack alarms for sev3
             */
            this.stackAlarms = new DomainValidationAlarms(this, {
                accountId: domainValidationStackProps.accountId,
                region: domainValidationStackProps.region,
                stage: domainValidationStackProps.stage,
            });

            /**
             * Step up domain validation stack alarms for sev2
             */
            this.sev2StackAlarms = new Sev2DomainValidationAlarms(this, {
                accountId: domainValidationStackProps.accountId,
                region: domainValidationStackProps.region,
                stage: domainValidationStackProps.stage,
            });
        }

        // Backfilling only required in NA region. TODO : Remove these resources once backfilling is not required
        if(domainValidationStackProps.realm == 'USAmazon') {

            // create a role for this lambda and add code to also assume IAM role of other account for DDB access
            let backfillLambda = new lambda.Function(this, 'BackfillLambda' , {
                functionName: `BackfillLambda`,
                code: LambdaAsset.fromBrazil({
                    brazilPackage: BrazilPackage.fromString("EverCBackfillLambda-1.0"),
                    componentName: 'BackfillLambda'
                }),
                timeout: Duration.seconds(180),
                memorySize: 512,
                runtime: lambda.Runtime.JAVA_11,
                handler: 'com.amazon.evercbackfilllambda.lambda.handler.EverCBackFillEventHandler',
                environment: {
                    Realm: domainValidationStackProps.realm,
                    Stage: domainValidationStackProps.domain
                }
            });
            // defaulting to queue params for now, will modify while testing integration
            const backfillQueueName = 'BackfillQueue';

            const backfillDlq = new Queue(this, backfillQueueName + dlqSuffix, {
                queueName: backfillQueueName + dlqSuffix,
                retentionPeriod: Duration.days(14),
                visibilityTimeout: Duration.seconds(60)
            });

            let backfillQueue = new Queue(this, backfillQueueName, {
                queueName: backfillQueueName,
                visibilityTimeout: Duration.minutes(9),
                retentionPeriod: Duration.days(10),
                deadLetterQueue: {
                    maxReceiveCount: 6,
                    queue: backfillDlq
                }
            });

            const backfillValidationErrorQueueName = backfillQueueName + '-ValidationErrorQueue';
            const backfillValidationErrorQueue = new Queue(this, backfillValidationErrorQueueName, {
                queueName: backfillValidationErrorQueueName,
                retentionPeriod: Duration.days(14),
                visibilityTimeout: Duration.seconds(60)
            });

            backfillValidationErrorQueue.grantSendMessages(backfillLambda);

            backfillLambda.addEventSource(new SqsEventSource(backfillQueue, {
                batchSize: 1
            }));
            backfillQueue.grantConsumeMessages(backfillLambda);

            backfillLambda.addToRolePolicy(new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['sts:AssumeRole'],
                resources: ['*'],
            }));

            ddbDomainValidationTable.grantReadWriteData(backfillLambda);
            ddbUrlInvestigationTable.grantReadWriteData(backfillLambda);

            let secretKey: string;
            if(domainValidationStackProps.domain == 'prod') {
                secretKey = 'prod.everc.bearer-token';
            } else {
                secretKey = 'devo.everc.bearer-token';
            }
            const secret = new secretsmanager.Secret(this, secretKey, {
                secretName: secretKey,
                description: 'This secret stores the bearer token for EverC auth'
            });
            secret.grantRead(backfillLambda);

        }

    }

    private createLambdaInvocationRole(domainValidationStackProps: DomainValidationStackProps): Role {
        const role = new Role(this, DomainValidation + domainValidationStackProps.localResourceNameSuffix + "-lambda-role", {
            assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                domainValidationStackProps.cloudauth.cloudAuthManagedPolicy,
                ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
            ]
        });

        role.addToPolicy(
            new PolicyStatement({
                actions: [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                    "iam:List*",
                    "s3:*",
                    "cloudwatch:PutMetricData",
                    "sqs:*",
                    "lambda:*",
                    "sns:*",
                    "states:*",
                    "cloudcover:CreateCoverageGroup",
                    "cloudcover:CreateCoverageArtifactPreSignedUrl"
                ],
                resources: [`*`],
            })
        );

        return role;
    }

    private createLambdaInvocationRoleForGetLatestVendorReviewResponse(domainValidationStackProps: DomainValidationStackProps, lambdaName: String): Role {
        const role = new Role(this, DomainValidation + domainValidationStackProps.localResourceNameSuffix + "-" + lambdaName + "-lambda-role", {
            assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                domainValidationStackProps.cloudauth.cloudAuthManagedPolicy,
                ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
            ]
        });

        role.addToPolicy(
            new PolicyStatement({
                actions: [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream"
                ],
                resources: ['arn:aws:logs:*:*:log-group:/aws/lambda/' + lambdaName + domainValidationStackProps.localResourceNameSuffix]
            })
        );

        role.addToPolicy(
            new PolicyStatement({
                actions: [
                    "logs:PutLogEvents"
                ],
                resources: ['arn:aws:logs:*:*:log-group:/aws/lambda/' + lambdaName + domainValidationStackProps.localResourceNameSuffix + ':log-stream:*'],
            })
        );

        role.addToPolicy(
            new PolicyStatement({
                actions: [
                    "cloudwatch:PutMetricData"
                ],
                resources: ['*']
            })
        );

        role.addToPolicy(
            new PolicyStatement({
                actions: [
                    "dynamodb:GetItem",
                    "dynamodb:Query"
                ],
                resources: [
                    'arn:aws:dynamodb:*:*:table/DomainValidationTable' + domainValidationStackProps.localResourceNameSuffix,
                    'arn:aws:dynamodb:*:*:table/UrlInvestigationTable' + domainValidationStackProps.localResourceNameSuffix
                ]
            })
        );

        return role;
    }

    private createLambdas(lambdaFunctionNames: string[], role: Role, domainValidationStackProps: DomainValidationStackProps,
        snsTopicArn: string): Map<string, LambdaMetadata> {

        let functions: Map<string, LambdaMetadata> = new Map<string, LambdaMetadata>();

        for (let lambdaName of lambdaFunctionNames) {
            let dlq = this.createLambdaDLQ(lambdaName)
            let lambdaFunc = this.createLambda(lambdaName, role, domainValidationStackProps, snsTopicArn, dlq!)

            functions.set(lambdaName, {
                lambdaFunc: lambdaFunc,
                dlq: dlq
            })
        }
        return functions;
    }

    private createLambdaDLQ(lambdaName: string) : Queue {
        const dlqId = dlqName(lambdaName);
        let dlq: Queue;
        if (dlqProps.has(dlqId)) {
            dlq = new Queue(this, dlqId, dlqProps.get(dlqId))
        }
        return dlq!;
    }

    private createLambda(lambdaName: string, role: Role, domainValidationStackProps: DomainValidationStackProps, snsTopicArn: string, dlq?: Queue) : lambda.Function {
        let logGroup = new log.CfnLogGroup(this, DomainValidation + "-log-group" + lambdaName, {
            logGroupName: '/aws/lambda/' + 'DomainValidationLambdaLogs/' + lambdaName,
            retentionInDays: 180, //TODO: adjust if required
        })

        let handlerFuncName = DomainValidationStack.resourceNamesplit(lambdaName, '-', 0);
        //TODO: Add other handlers and respective resource permission after completing code changes in the Lambda package.
        let lambdaFunc = new lambda.Function(this, DomainValidation + lambdaName, {
            functionName: lambdaName,
            description: "TODO", //TODO: Update summary once lambda code is completed.
            runtime: lambda.Runtime.JAVA_11,
            handler: getHandler(handlerFuncName),
            code: LambdaAsset.fromBrazil({
                brazilPackage: BrazilPackage.fromString("AmazonPayMerchantURL-1.0"),
                componentName: "DomainValidationLambda",
            }),
            timeout: Duration.seconds(180), //TODO: adjust if required
            role: role,
            memorySize: 1024, //TODO: tune once we are in stable state. (will help in detecting buggy code)
            retryAttempts: 2,
            vpc: domainValidationStackProps.vpc,
            vpcSubnets: {
                subnetType: SubnetType.PRIVATE
            },
            environment: {
                Realm: domainValidationStackProps.realm,
                Stage: domainValidationStackProps.domain,
                UrlStatusNotificationTopic: snsTopicArn,
                JAVA_TOOL_OPTIONS: '-javaagent:lib/jacocoagent.jar=output=none,dumponexit=false'
            },
            deadLetterQueue: dlq
        });

        lambdaFunc.node.addDependency(logGroup)
        return lambdaFunc
    }

    private createDomainValidationTable(tableName: string): dynamodb.Table {
        const ddbTable = new dynamodb.Table(this, tableName, {
            tableName: tableName,
            partitionKey: {
                name: clientReferenceGroupIdAttributeName,
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: URLAttributeName,
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, //TODO: Discuss and select
            pointInTimeRecovery: true, //TODO: disable if not required
        });

        ddbTable
            .addGlobalSecondaryIndex({
                indexName: caseIdIndexName,
                partitionKey: {name: caseIDAttributeName, type: dynamodb.AttributeType.NUMBER},
            });

        ddbTable
            .addGlobalSecondaryIndex({
                indexName: clientRefGroupId_NormalizedUrlIndexName,
                partitionKey: {name: clientReferenceGroupIdAttributeName, type: dynamodb.AttributeType.STRING},
                sortKey: {name: normalizedUrlAttributeName, type: dynamodb.AttributeType.STRING}
            });

        return ddbTable;
    }

    private createUrlInvestigationTable(tableName: string): dynamodb.Table {
        const ddbTable = new dynamodb.Table(this, tableName, {
            tableName: tableName,
            partitionKey: {
                name: investigationIdAttributeName,
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: subInvestigationTypeAttributeName,
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecovery: true,
        });
        // TODO: To reconsider traffic pattern and then decide on target utilization

        // Adding clientRefGrpId_Url GSI
        ddbTable
            .addGlobalSecondaryIndex({
                indexName: clientRefGroupId_UrlIndexName,
                partitionKey: {name: clientRefGroupId_UrlAttributeName, type: dynamodb.AttributeType.STRING},
                sortKey: {name: reviewStartTimeAttributeName, type: dynamodb.AttributeType.NUMBER}
            });

        // Adding subInvestigationId GSI
        ddbTable
            .addGlobalSecondaryIndex({
                indexName: subInvestigationIdIndexName,
                partitionKey: {name: subInvestigationIdAttributeName, type: dynamodb.AttributeType.STRING},
            });

        return ddbTable;
    }

    private static createSNSPolicyRole(snsTopic: Topic, accountId: string) {
        snsTopic.addToResourcePolicy(
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ["sns:Publish"],
                resources: [snsTopic.topicArn],
                principals: [new AccountPrincipal(accountId)],
            })
        );
    }

    private static addSubscribtionToTopic(stack: Construct, topic: Topic, props: DeploymentStackProps,
                                          domainValidationProps: DomainValidationStackProps) {
        const subscriptionId = urlStatusSubscription(domainValidationProps.stage, domainValidationProps.region);
        const sqsArn = Fn.findInMap(domainValidationProps.cfnMapping?.logicalId?? '',
            domainValidationProps.region,
            domainValidationProps.stage.split('-')[0] + merchantURLStatusQueueMappingKey);

        // TODO : Add dlq to subscription if required
        return new Subscription(stack, subscriptionId, {
            topic: topic,
            protocol: SubscriptionProtocol.SQS,
            endpoint: sqsArn,
            rawMessageDelivery: true
        });
    }

    private createAPIGateway(idPrefix: string, lambdaFunctions: Map<string, LambdaMetadata>, nameSuffix: string) {

        const accessLogGroup = new LogGroup(this, 'AccessLogs', {
            logGroupName: '/aws/' + DomainValidation + '-api-gateway-access-logs' + nameSuffix + '/',
            retention: RetentionDays.SIX_MONTHS
        });

        //we are giving first lambda as default for root.
        let defaultLambdaFunc: IFunction;
        for (let [, funcMeta] of lambdaFunctions) {
            defaultLambdaFunc = funcMeta.lambdaFunc
            break;
        }

        const restApi = new LambdaRestApi(this, DomainValidation + nameSuffix, {
            restApiName: DomainValidation + nameSuffix,
            handler: defaultLambdaFunc!,
            proxy: false,
            //endpointTypes: [EndpointType.EDGE],
            cloudWatchRole: true,
            deployOptions: {
                //TODO: after few days launch reduce logging to save cloudwatch bills.
                tracingEnabled: true,
                dataTraceEnabled: true,
                accessLogDestination: new LogGroupLogDestination(accessLogGroup),
                accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
                loggingLevel: MethodLoggingLevel.INFO,
                metricsEnabled: true,
                stageName: idPrefix,
                // throttlingBurstLimit: 10000, //uncomment if we want to change the default.
                // throttlingRateLimit : 5000,
            },
            deploy: true
            //Adding policy over this API if required (to restrict resources touched via this API)
        });

        for (let [funcName, funcMeta] of lambdaFunctions) {
            let lambdaFunc: IFunction = funcMeta.lambdaFunc
            const requestValidator = new RequestValidator(this, funcName + 'Validator', {
                requestValidatorName: funcName + 'Validator',
                restApi: restApi,
                validateRequestBody: true,
                validateRequestParameters: true
            })
            let funcNameMapping = DomainValidationStack.resourceNamesplit(funcName, '-', 0);
            const httpMethodName = httpMethods.get(funcNameMapping) as string;

            if(funcNameMapping === getLatestVendorReviewResponse) {
                const lambdaIntegration = new LambdaIntegration(lambdaFunc, {
                    //As this is sync API and we do not need any complex response transformation so keeping proxy: true
                    proxy: true,
                    allowTestInvoke: true
                });
                let rootFunction = restApi.root
                    .addResource(funcName)

                for(let resource of resources.get(funcNameMapping) as string[]) {
                    rootFunction = rootFunction.addResource(resource);
                }

                rootFunction.addMethod(httpMethodName, lambdaIntegration, {
                    requestParameters: requestParams.get(funcNameMapping) as { [param: string]: boolean; },
                    requestValidator: requestValidator,
                    authorizationType: AuthorizationType.IAM,
                });
            } else {
                const lambdaIntegration = new LambdaIntegration(lambdaFunc, {
                    proxy: false,
                    allowTestInvoke: true,
                    requestParameters: {'integration.request.header.X-Amz-Invocation-Type': "'Event'"},
                    passthroughBehavior: PassthroughBehavior.WHEN_NO_MATCH,
                    integrationResponses: integrationResponse
                    //connectionType:
                    //vpcLink:
                });
                const addResponseModel = new Model(this, funcName + 'ResponseModel', {
                    restApi: restApi,
                    contentType: 'application/json',
                    schema: responseSchemas.get(funcNameMapping) as jsonSchema.JsonSchema
                });

                let methodResponses = []
                for (let code of StatusCodes) {
                    methodResponses.push({
                            statusCode: code,
                            //If required, add Cross-Origin Resource Policy (CORP) or other header options.
                            responseParameters: {'method.response.header.Content-Type': true},
                            responseModels: {'application/json': addResponseModel}
                        }
                    )
                }
                const addRequestModel = new Model(this, funcName + 'RequestModel', {
                    restApi: restApi,
                    contentType: 'application/json',
                    schema: requestSchemas.get(funcNameMapping) as jsonSchema.JsonSchema,
                })
                const rootFunction = restApi.root.addResource(funcName);
                rootFunction.addMethod(httpMethodName, lambdaIntegration, {
                    requestModels: {'application/json': addRequestModel},
                    requestValidator: requestValidator,
                    authorizationType: AuthorizationType.IAM,
                    methodResponses: methodResponses
                });
            }
        }
    }


    private createSQS(lambdaName: string, lambdaFunc: lambda.Function,
                      domainValidationProps: DomainValidationStackProps) {
        let queueName: string;
        let queue: Queue;

        if (functionAndQueueMap.has(lambdaName)) {
            queueName = functionAndQueueMap.get(lambdaName)!;
            const deadLetterQueue = new Queue(this, queueName + dlqSuffix, {
                queueName: queueName + dlqSuffix,
                retentionPeriod: Duration.days(14),
                visibilityTimeout: Duration.seconds(60)
            });

            let mainQueueName = queueName + mainQueueSuffix;

            queue = new Queue(this, mainQueueName, {
                queueName: mainQueueName,
                visibilityTimeout: Duration.seconds(240),
                retentionPeriod: Duration.days(2),
                receiveMessageWaitTime: Duration.seconds(20),
                deadLetterQueue: {
                    maxReceiveCount: 3,
                    queue: deadLetterQueue
                }
            });

            //TODO: Remove realm check, once EverCompliant creates roles for other other realms.
            if (domainValidationProps.stage.endsWith('NA') || domainValidationProps.stage.endsWith('EU')) {
                if (queueAndAccountRoleArnMap.has(mainQueueName)) {
                    let arnPrincipal = queueAndAccountRoleArnMap.get(mainQueueName)!;
                    queue.addToResourcePolicy(new PolicyStatement({
                        actions: ['sqs:SendMessage'],
                        effect: Effect.ALLOW,
                        resources: [queue.queueArn],
                        principals: [new ArnPrincipal(arnPrincipal)]
                    }));
                }
            }

            const errorQueue = new Queue(this, queueName + errorSuffix, {
                queueName: queueName + errorSuffix,
                retentionPeriod: Duration.days(14),
                visibilityTimeout: Duration.seconds(60)
            });

            lambdaFunc.addEventSource(new SqsEventSource(queue, {
                batchSize: 1
            }));
            queue.grantConsumeMessages(lambdaFunc);
            const errorQueueUrl = getQueueUrl(domainValidationProps.region,
                domainValidationProps.accountId, queueName + errorSuffix);
            lambdaFunc.addEnvironment(vendorResponseValidationErrorQueueUrl, errorQueueUrl);
        }
    }

    private createS3(s3BucketName: string, stage: string) {
        const s3 = new Bucket(this, s3BucketName, {
            bucketName: s3BucketName,
            lifecycleRules: [
                {
                    expiration: Duration.days(14)
                }
            ]
        });

        //TODO: Remove realm check, once EverCompliant creates roles for other other realms.
        if (stage.endsWith('NA') || stage.endsWith('EU')) {
            if (s3AndAccountRoleArnMap.has(s3BucketName)) {
                let arnPrincipal = s3AndAccountRoleArnMap.get(s3BucketName)!;
                s3.addToResourcePolicy(new PolicyStatement({
                    actions: ['s3:PutObject'],
                    effect: Effect.ALLOW,
                    resources: [s3.bucketArn + '/*'],
                    principals: [new ArnPrincipal(arnPrincipal)]
                }));
            }
        }
    }

    private createHydraTestRunResources(name: string, env: IHydraEnvironment): HydraTestRunResources {
        return new HydraTestRunResources(this, name, {
            hydraEnvironment: env,
            targetPackage: BrazilPackage.fromString(testPackage)
        });
    }

    private createErrorQueueForLambda(lambdaName: string, domainValidationProps: DomainValidationStackProps) : Queue {
        const errorQueueName = getErrorQueueName(lambdaName);

        const errorQueue = new Queue(this, errorQueueName, {
            queueName: errorQueueName,
            retentionPeriod: Duration.days(14),
            visibilityTimeout: Duration.seconds(240)
        });

        return errorQueue;
    }

    private static resourceNamesplit(name: string, dilimeter: string, index: number): string {
        return name.split(dilimeter)[index];
    }

    private static resourceName(resourceName: string, resourceNamesSuffix: string): string {
        return resourceName + resourceNamesSuffix;
    }

    private static resourceNames(resourceNames: string[], resourceNamesSuffix: string): string[] {
        let names = [];
        for (let name of resourceNames) {
            names.push(DomainValidationStack.resourceName(name, resourceNamesSuffix))
        }
        return names;
    }
}