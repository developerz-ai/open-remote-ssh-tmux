import * as net from 'net';

/**
 * Finds a random unused port assigned by the operating system. Will reject in case no free port can be found.
 */
export function findRandomPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer({ pauseOnConnect: true });
        server.on('error', reject);
        server.on('listening', () => {
            const port = (server.address() as net.AddressInfo).port;
            server.close(() => resolve(port));
        });
        server.listen(0, '127.0.0.1');
    });
}
