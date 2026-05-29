/**
 * QuData API Client
 */

const axios = require('axios');

const BASE = 'https://qudata.ai';

class QuDataAPI {
  constructor() {
    this.session = axios.create({
      baseURL: BASE,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': BASE,
        'Referer': `${BASE}/en`,
      },
      withCredentials: true,
    });
    this.cookies = '';
  }

  async login(email, password) {
    try {
      await this.session.get('/auth/login');
      const { data, headers } = await this.session.post('/api/auth/signin', {
        login: email,
        password,
      });
      const setCookies = headers['set-cookie'];
      if (setCookies) {
        this.cookies = setCookies.map(c => c.split(';')[0]).join('; ');
        this.session.defaults.headers.Cookie = this.cookies;
      }
      return data.ok === true;
    } catch {
      return false;
    }
  }

  async getBalance() {
    try {
      const { data } = await this.session.get('/api/account/profile');
      const balance = data.data?.balance || {};
      return parseFloat(balance.usdt || 0);
    } catch {
      return 0;
    }
  }

  async getOffers(priceMin, priceMax) {
    const allOffers = [];
    let start = 0;
    while (start < 3000) {
      try {
        const { data } = await this.session.get('/api/market/offers', {
          params: { start, limit: 100, currency: 'USD', only_active: 'true' },
        });
        const offers = data.data || [];
        if (!offers.length) break;
        allOffers.push(...offers);
        start += 100;
      } catch { break; }
    }
    return allOffers
      .filter(o => {
        if (!o.rentable || !o.in_stock) return false;
        const price = o.prices?.[0]?.amount || 0;
        return price >= priceMin && price <= priceMax;
      })
      .sort((a, b) => (a.prices?.[0]?.amount || 999) - (b.prices?.[0]?.amount || 999));
  }

  // Returns ALL rentable offers in price range (no balance filter)
  async getOffersAll(priceMin, priceMax) {
    return this.getOffers(priceMin, priceMax);
  }

  // Filter out blacklisted providers (vast.ai etc)
  // DISABLED - detect on instance status instead
  filterOffers(offers) {
    return offers;
  }

  async getTemplates() {
    try {
      const { data } = await this.session.get('/api/templates');
      return data.data || [];
    } catch {
      return [];
    }
  }

  async createInstance(offerId, deploymentType = 'jupyter', storageGb = 32) {
    try {
      const payload = {
        offer_id: offerId,
        deployment_type: deploymentType,
        storage_gb: storageGb,
      };
      const { data } = await this.session.post('/api/instances', payload);
      if (data.ok) return data.data;
      console.log(`      [API] ❌ Response: ${JSON.stringify(data).substring(0, 300)}`);
      return { error: 'response_not_ok', data };
    } catch (e) {
      const status = e.response?.status || '?';
      const body = e.response?.data ? JSON.stringify(e.response.data).substring(0, 300) : e.message;
      console.log(`      [API] ❌ Failed [${status}]: ${body}`);
      return { error: 'http_error', status };
    }
  }

  async getInstances() {
    try {
      const { data } = await this.session.get('/api/instances');
      return data.data || [];
    } catch {
      return [];
    }
  }

  async deleteInstance(instanceId) {
    try {
      const { data } = await this.session.delete(`/api/instances/${instanceId}`);
      return data?.ok !== false;
    } catch (e) {
      const status = e.response?.status || '?';
      const msg = e.response?.data?.message || e.message;
      console.log(`      [API] ❌ Delete failed [${status}]: ${msg}`);
      return false;
    }
  }

  async ensureSSHKey(keyName, publicKey) {
    try {
      const { data } = await this.session.get('/api/secrets');
      const existing = (data.data || []).find(
        s => s.name === keyName && s.secret_type === 'ssh'
      );
      if (existing) return existing.id;
    } catch {}
    try {
      const { data } = await this.session.post('/api/secrets', {
        name: keyName, secret_type: 'ssh', value: publicKey,
      });
      return data.ok ? data.data.id : null;
    } catch { return null; }
  }

  async attachSSHKey(instanceId, keyId) {
    try {
      const { data } = await this.session.post(
        `/api/instances/${instanceId}/secrets`,
        { secret_id: keyId }
      );
      return data.ok;
    } catch { return false; }
  }
}

module.exports = QuDataAPI;
