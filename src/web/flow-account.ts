export interface FlowAccountStatus {
  ready: boolean;
  message: string;
  loginPending?: boolean;
}

export class FlowAccountError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "FlowAccountError";
  }
}

const pendingStatus = (): FlowAccountStatus => ({
  ready: false,
  loginPending: true,
  message: "Đăng nhập Google Flow trong cửa sổ Chrome vừa mở. Khi hoàn tất, quay lại và bấm Kiểm tra lại."
});

export class FlowAccount {
  loginPending = false;
  private opening?: Promise<FlowAccountStatus>;
  private checking?: Promise<FlowAccountStatus>;

  constructor(private readonly dependencies: {
    isBusy(): boolean;
    openLogin(): Promise<void>;
    check(): Promise<FlowAccountStatus>;
  }) {}

  private assertAvailable(): void {
    if (this.dependencies.isBusy()) {
      throw new FlowAccountError("Đang tạo video. Hãy chờ hoàn tất trước khi thay đổi hoặc kiểm tra tài khoản Google Flow.", "FLOW_BUSY", 409);
    }
  }

  async login(): Promise<FlowAccountStatus> {
    this.assertAvailable();
    if (this.opening) return this.opening;
    this.opening = (async () => {
      if (this.checking) await this.checking;
      this.assertAvailable();
      this.loginPending = true;
      try {
        await this.dependencies.openLogin();
        return pendingStatus();
      } catch {
        this.loginPending = false;
        throw new FlowAccountError("Không mở được Chrome để đăng nhập Google Flow. Hãy kiểm tra Chrome đã cài đặt và thử lại.", "FLOW_LOGIN_FAILED", 502);
      }
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  async check(verifyLogin = false): Promise<FlowAccountStatus> {
    if (this.opening) await this.opening;
    if (this.loginPending && !verifyLogin) return pendingStatus();
    this.assertAvailable();
    if (this.checking) return this.checking;
    this.checking = this.dependencies.check();
    try {
      const result = await this.checking;
      this.loginPending = false;
      return result;
    } finally {
      this.checking = undefined;
    }
  }
}
