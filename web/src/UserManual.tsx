import React from 'react';
import { Alert, Card, Collapse, Descriptions, Divider, List, Space, Steps, Table, Tag, Typography } from 'antd';

const {Title,Paragraph,Text,Link}=Typography;

const channels=[
  {key:'line',name:'LINE OA',credentials:'channelSecret, channelAccessToken',inbound:'Signed webhook',outbound:'Push API',notes:'Set the channel webhook to the bridge URL. Enable webhooks in LINE Developers.'},
  {key:'facebook',name:'Facebook Messenger',credentials:'appSecret, verifyToken, pageAccessToken, pageId',inbound:'Meta webhook',outbound:'Graph API',notes:'Subscribe the Page to message events and obtain approved Page messaging permissions.'},
  {key:'instagram',name:'Instagram DM',credentials:'appSecret, verifyToken, pageAccessToken, pageId',inbound:'Meta webhook',outbound:'Graph API',notes:'Use a connected professional Instagram account and Page with approved messaging permissions.'},
  {key:'whatsapp',name:'WhatsApp Cloud API',credentials:'appSecret, verifyToken, accessToken, phoneNumberId',inbound:'Meta webhook',outbound:'Cloud API',notes:'Subscribe to messages. Add optional fallback template name/language when policy requires a template.'},
  {key:'telegram',name:'Telegram',credentials:'webhookSecret, botToken',inbound:'Bot webhook',outbound:'Bot API',notes:'Call setWebhook with the bridge URL and the same secret_token.'},
  {key:'msteams',name:'Microsoft Teams',credentials:'MicrosoftAppId, MicrosoftAppPassword, MicrosoftAppTenantId (single-tenant)',inbound:'Bot Framework activity webhook',outbound:'Bot Framework Connector API',notes:'Register an Azure Bot and enable the Teams channel. Configure its messaging endpoint to this bridge webhook. Use the Entra tenant ID for single-tenant apps.'},
  {key:'youtube',name:'YouTube',credentials:'Choose OAuth: channelId + client credentials; or API key: channelId + apiKey',inbound:'OAuth or API-key polling',outbound:'OAuth only',notes:'OAuth is two-way. API-key mode is public comment polling only and cannot deliver agent replies.'},
  {key:'x',name:'X DM',credentials:'userAccessToken, ownUserId',inbound:'DM polling',outbound:'DM API',notes:'Requires an X plan and token with DM read/write access.'},
  {key:'wechat',name:'WeChat Official Account',credentials:'verifyToken, appId, appSecret',inbound:'Plaintext XML',outbound:'Customer service API',notes:'Configure plaintext callback mode. Encrypted callbacks are not supported.'},
  {key:'tiktok',name:'TikTok',credentials:'clientSecret, accessToken, businessSendUrl',inbound:'Signed webhook/polling',outbound:'Approved tenant endpoint',notes:'Requires tenant-approved access. commentsPollUrl is optional.'},
  {key:'pantip',name:'Pantip.com',credentials:'webhookSecret, outboundUrl, accessToken',inbound:'Certified partner webhook',outbound:'Certified partner endpoint',notes:'Requires Pantip Certified Developer or partner access. The bridge does not scrape Pantip.'},
  {key:'generic',name:'Generic REST',credentials:'webhookSecret, outboundUrl, optional outboundToken',inbound:'HMAC JSON webhook',outbound:'HTTPS JSON POST',notes:'Use for a custom platform implementing the documented bridge contract.'},
];

const numbered=(items:string[])=> <List size="small" dataSource={items} renderItem={(item,index)=><List.Item><Text strong>{index+1}.</Text>&nbsp;{item}</List.Item>}/>;

export function UserManual({base}:{base:string}){
  const channelWebhook=`${base}/webhooks/channel/<channel-id>`;
  const genesysWebhook=`${base}/webhooks/genesys/<genesys-integration-id>`;
  const youtubeCallback=`${base}/api/oauth/youtube/callback`;
  return <Space direction="vertical" size="large" style={{width:'100%'}}>
    <Card>
      <Title level={2}>MessageAPI user manual</Title>
      <Paragraph>Use this console to connect external digital platforms to Genesys Cloud Open Messaging. Configure one channel at a time and keep it disabled until a real message and agent reply both succeed.</Paragraph>
      <Alert type="info" showIcon message="Production address" description={<Text copyable>{base}</Text>}/>
    </Card>

    <Card title="1. Initial setup">
      <Steps direction="vertical" size="small" items={[
        {title:'Sign in and change the administrator password',description:'Use the first-run credentials stored on the server, then change the password under Settings.'},
        {title:'Set the public base URL',description:<span>In Settings, enter <Text code>{base}</Text> and save.</span>},
        {title:'Back up the encryption key and data',description:'Back up C:\\MessageAPI\\.env and C:\\MessageAPI\\data together. Encrypted credentials require the matching key.'},
        {title:'Confirm service health',description:<span>Open <Link href={`${base}/health`} target="_blank">{base}/health</Link>; it should return status ok.</span>},
      ]}/>
    </Card>

    <Card title="2. Configure Genesys Cloud">
      {numbered([
        'Create a Genesys OAuth client using the Client Credentials grant. Assign a role permitted to use Open Messaging inbound APIs.',
        'In Genesys Admin, open Message > Platforms > Platform Integrations and create an Open Messaging integration. Record its integration ID.',
        'In this console, open Genesys Integrations > Add integration. Enter a local configuration ID, name, Genesys region, OAuth client ID/secret, Open Messaging integration ID, and a strong webhook signature secret.',
        'Keep Verify outbound signature enabled, save, then click Test. A successful test confirms OAuth token acquisition.',
        'Copy the generated webhook URL into Genesys as the Outbound Notification Webhook URL. Enter the same signature secret in Genesys and activate the integration.',
        'Configure the Genesys message flow, queue, and agent routing. OAuth success alone does not test routing or channel delivery.',
      ])}
      <Descriptions bordered size="small" column={1} style={{marginTop:16}}>
        <Descriptions.Item label="Genesys outbound webhook"><Text copyable>{genesysWebhook}</Text></Descriptions.Item>
        <Descriptions.Item label="Network requirement">Public HTTPS on port 443; do not append :3000 or :8080.</Descriptions.Item>
      </Descriptions>
    </Card>

    <Card title="3. Add and test a digital channel">
      {numbered([
        'Open Channels > Add channel. Choose a permanent Channel ID, name, type, and the Genesys integration.',
        'Leave Enabled off. Enter the platform credentials listed below and save.',
        'Copy the inbound webhook URL into the platform developer console. Polling channels such as YouTube and X do not use this URL.',
        'Click Test to check the required configuration. This is a configuration check, not an end-to-end delivery test.',
        'Enable the channel. Send a real customer message and verify it appears in Message Explorer and reaches a Genesys agent.',
        'Reply from Genesys and confirm the reply reaches the platform. Review Queue, Dead letters, and Recent errors if delivery fails.',
      ])}
      <Paragraph><Text strong>Inbound webhook pattern: </Text><Text copyable>{channelWebhook}</Text></Paragraph>
      <Table size="small" scroll={{x:1000}} pagination={false} dataSource={channels} columns={[
        {title:'Channel',dataIndex:'name',width:160,fixed:'left'},
        {title:'Credentials',dataIndex:'credentials',width:260,render:value=><Text code>{value}</Text>},
        {title:'Inbound',dataIndex:'inbound',width:150},
        {title:'Outbound',dataIndex:'outbound',width:180},
        {title:'Setup notes',dataIndex:'notes'},
      ]}/>
    </Card>

    <Card title="4. Connect YouTube with OAuth 2.0">
      <Alert type="warning" showIcon message="Use user OAuth for a normal YouTube channel" description="Service accounts work only for eligible YouTube Content Owner/CMS scenarios." style={{marginBottom:16}}/>
      {numbered([
        'In Google Cloud, enable YouTube Data API v3 and configure the OAuth consent screen.',
        'Create an OAuth client with application type Web application.',
        `Add this exact Authorized redirect URI: ${youtubeCallback}`,
        'Create or edit a YouTube channel and choose Authentication. OAuth asks for channelId and OAuth client credentials. API key asks only for channelId and apiKey and is read-only.',
        'Click Connect YouTube. Sign in with a channel owner or manager account and grant access.',
        'After returning to the console, click Test. The refresh token is encrypted and access tokens renew automatically.',
      ])}
      <Paragraph><Text strong>OAuth redirect URI: </Text><Text copyable>{youtubeCallback}</Text></Paragraph>
    </Card>

    <Card title="5. Routing and operation">
      <Collapse items={[
        {key:'routing',label:'Routing / Mapping',children:<Paragraph>Choose the Genesys integration on each channel. Queue ID and flow ID fields are routing hints; configure the actual flow and queue assignment in Genesys Cloud. Business hours default to 24/7. Choose a custom Monday-to-Friday schedule only when the channel needs an out-of-hours auto reply.</Paragraph>},
        {key:'messages',label:'Message Explorer and Sessions',children:<Paragraph>Message Explorer records normalized inbound and outbound activity. Sessions map a platform user to a Genesys conversation. End a session only when you want the next message to start a new conversation.</Paragraph>},
        {key:'queue',label:'Queue and dead letters',children:<Paragraph>Transient outbound failures retry with exponential backoff. Retry a queue or dead-letter item after correcting credentials, access, or network problems. Purge permanently discards pending work.</Paragraph>},
        {key:'backup',label:'Backup and encryption',children:<Paragraph>Settings export contains encrypted credentials. Preserve the matching .env encryption key. After key rotation, immediately back up the new .env file with the data directory.</Paragraph>},
      ]}/>
    </Card>

    <Card title="6. Troubleshooting">
      <Table size="small" pagination={false} rowKey="problem" dataSource={[
        {problem:'Health returns 502',check:'Check the MessageAPI Bridge scheduled task, Node on 127.0.0.1:3000, nginx on 127.0.0.1:8080, and Cloudflare Tunnel.'},
        {problem:'Webhook verification fails',check:'Confirm the exact HTTPS URL and shared secret. Ensure proxies preserve the original request body because signatures cover its exact bytes.'},
        {problem:'Genesys Test fails',check:'Check region, OAuth client credentials, Client Credentials grant, and the assigned Genesys role.'},
        {problem:'Inbound does not reach an agent',check:'Check Message Explorer, Genesys integration ID, OAuth permission, message flow, queue, and agent routing.'},
        {problem:'Agent reply does not reach customer',check:'Check platform token/permissions, messaging window, Queue, Dead letters, and Recent errors.'},
        {problem:'YouTube OAuth fails',check:`Confirm the OAuth client is a Web application and its redirect URI exactly matches ${youtubeCallback}.`},
        {problem:'Channel says Ready but no traffic',check:'Ready verifies configuration fields only. Run a real two-way message test before production use.'},
      ]} columns={[{title:'Problem',dataIndex:'problem',width:240,render:value=><Tag color="orange">{value}</Tag>},{title:'What to check',dataIndex:'check'}]}/>
      <Divider/>
      <Paragraph type="secondary">Detailed server documentation is also available in <Text code>C:\MessageAPI\docs\USER_MANUAL.md</Text> and <Text code>C:\MessageAPI\docs\API.md</Text>.</Paragraph>
    </Card>
  </Space>;
}
