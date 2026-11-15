#import "PocketNetTransport.h"

static pocket_net_done_cb g_done_cb = NULL;
static pocket_net_error_cb g_error_cb = NULL;

@implementation PocketNetTransport

- (instancetype)initWithHandle:(int32_t)handle
                           url:(NSString *)url
                        method:(NSString *)method
                   headersJson:(NSString *)headersJson
                          body:(NSData *)body {
    self = [super init];
    if (self) {
        _handle = handle;
        _url = url;
        _method = method;
        _headersJson = headersJson;
        _body = body;
        _responseData = [NSMutableData data];
    }
    return self;
}

- (NSURLConnection *)startConnection {
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:self.url]];
    [req setHTTPMethod:self.method];
    if (self.body.length > 0) [req setHTTPBody:self.body];
    if (self.headersJson.length > 0) {
        NSData *data = [self.headersJson dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *headers = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        for (NSString *key in headers) {
            [req setValue:headers[key] forHTTPHeaderField:key];
        }
    }
    req.timeoutInterval = 30.0;
    return [[NSURLConnection alloc] initWithRequest:req delegate:self];
}

#pragma mark - NSURLConnectionDataDelegate

- (void)connection:(NSURLConnection *)connection didReceiveData:(NSData *)data {
    [self.responseData appendData:data];
}

- (void)connection:(NSURLConnection *)connection didReceiveResponse:(NSURLResponse *)response {
    self.httpResponse = (NSHTTPURLResponse *)response;
}

- (void)connectionDidFinishLoading:(NSURLConnection *)connection {
    int32_t h = self.handle;
    uint16_t status = (uint16_t)self.httpResponse.statusCode;
    const char *url = [self.url UTF8String];

    NSMutableDictionary *headers = [NSMutableDictionary dictionary];
    for (NSString *key in self.httpResponse.allHeaderFields) {
        headers[[key lowercaseString]] = self.httpResponse.allHeaderFields[key];
    }
    NSData *headersData = [NSJSONSerialization dataWithJSONObject:headers options:0 error:nil];
    NSString *headersJson = [[NSString alloc] initWithData:headersData encoding:NSUTF8StringEncoding];

    if (g_done_cb) {
        g_done_cb(h, status, url, [headersJson UTF8String],
                  self.responseData.bytes, (size_t)self.responseData.length);
    }
}

- (void)connection:(NSURLConnection *)connection didFailWithError:(NSError *)error {
    if (g_error_cb) {
        g_error_cb(self.handle, "network", [error.localizedDescription UTF8String]);
    }
}

@end

void pocket_net_set_callbacks(pocket_net_done_cb done, pocket_net_error_cb error) {
    g_done_cb = done;
    g_error_cb = error;
}

void pocket_net_request(const char *url, const char *method,
                        const char *headers_json, const uint8_t *body,
                        size_t body_len, int32_t handle) {
    NSString *nsUrl = [NSString stringWithUTF8String:url];
    NSString *nsMethod = [NSString stringWithUTF8String:method];
    NSString *nsHeaders = [NSString stringWithUTF8String:headers_json];
    NSData *nsBody = [NSData dataWithBytes:body length:body_len];

    PocketNetTransport *t = [[PocketNetTransport alloc] initWithHandle:handle
                                                                   url:nsUrl
                                                                method:nsMethod
                                                           headersJson:nsHeaders
                                                                  body:nsBody];
    [t startConnection];
}
EOF   
